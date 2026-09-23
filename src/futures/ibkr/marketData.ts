import { BarSizeSetting, ConnectionState, IBApiNext, IBApiTickType as Tick, WhatToShow, type HistoricalTickBidAsk, type HistoricalTickLast, type MarketDataType, type OrderBookRows } from "@stoqey/ib";
import { frontContract, SPECS, toTicks } from "../contracts";
import type { Bar, BarSize, BookLevel, BookSnapshot, DataHealth, FeedStatus, FuturesContract, MarketData, Print, Root } from "../types";
import { ibConfig } from "./config";
import { parseIbDate, toIbContract, until } from "./contract";

type PartName = "quotes" | "prints" | "depth";
interface Part { stop: (() => void) | null; issue: string | null; retry: ReturnType<typeof setTimeout> | null }

interface Stream {
  contract: FuturesContract;
  depthRows: number;
  bid: number; ask: number; bidSize: number; askSize: number; last: number | null;
  bids: BookLevel[]; asks: BookLevel[];
  delayed: boolean;
  parts: Record<PartName, Part>;
  onBook: Set<(b: BookSnapshot) => void>;
  onPrint: Set<(p: Print) => void>;
}

/** How a stream failed: the short reason for status lines, and the full explanation logged once. */
interface Problem { reason: string; explain: string }

const BAR_SIZES: Record<BarSize, BarSizeSetting> = { "5s": BarSizeSetting.SECONDS_FIVE, "1m": BarSizeSetting.MINUTES_ONE, "5m": BarSizeSetting.MINUTES_FIVE };

/** Codes that are routine (farm status, cancel echoes) or already explained per stream, so the global error log skips them. */
const QUIET_CODES = new Set([300, 354, 2104, 2106, 2107, 2108, 2119, 2158, 10090, 10167, 10189, 10197]);

export interface IbkrMarketDataOptions {
  /** Test seam: the IBApiNext instance to use. */
  api?: IBApiNext;
  /** Seconds between resubscribe attempts for a failed stream. Default IB_DATA_RETRY_S (120). */
  retrySeconds?: number;
  log?: (msg: string) => void;
}

/**
 * IBKR market data over TWS / IB Gateway, via IBApiNext (auto-reconnect, streams survive reconnects).
 *
 * Top of book: reqMktData. Prints: tick-by-tick AllLast, aggressor inferred from the quote in force. Depth:
 * reqMktDepth, which needs a paid CME/CBOT depth subscription and counts against IBKR's depth-line limit, so it
 * is opt-in per contract. IBKR samples top of book (a few updates a second) rather than sending every change, so
 * this is fine for decisions on a scale of seconds, not for queue-position market making.
 *
 * Quotes, prints and depth fail and recover independently. A failure (no subscription, no permissions, a
 * competing live session) is explained once in plain terms, shows in `health()`, clears the book so nothing
 * trades on a stale quote, and is retried every `retrySeconds`, so fixing the account needs no restart.
 */
export class IbkrMarketData implements MarketData {
  private api: IBApiNext;
  private streams = new Map<string, Stream>();
  private _status: FeedStatus = "disconnected";
  private readonly retryMs: number;
  private readonly log: (msg: string) => void;

  constructor(opts: IbkrMarketDataOptions = {}) {
    this.api = opts.api ?? new IBApiNext({ host: ibConfig.host, port: ibConfig.port, reconnectInterval: ibConfig.reconnectMs });
    this.retryMs = (opts.retrySeconds ?? ibConfig.dataRetrySeconds) * 1000;
    this.log = opts.log ?? ((m) => console.warn(`ibkr md: ${m}`));
  }

  get status() { return this._status; }

  async connect() {
    this.api.connectionState.subscribe((s) => {
      this._status = s === ConnectionState.Connected ? "connected" : s === ConnectionState.Connecting ? "connecting" : "disconnected";
    });
    this.api.error.subscribe((e) => { if (!QUIET_CODES.has(e.code)) this.log(`${e.code} ${e.error.message}`); });
    this.api.connect(ibConfig.clientId);
    await until(() => this._status === "connected", ibConfig.requestTimeoutMs, "IBKR market data connection");
    this.api.setMarketDataType(ibConfig.marketDataType as MarketDataType);
  }

  async close() {
    for (const s of this.streams.values()) this.stopAll(s);
    this.streams.clear();
    this.api.disconnect();
  }

  /** What is flowing for a contract right now, and if something is not, the short reason. */
  health(contract: FuturesContract): DataHealth {
    const s = this.streams.get(contract.code);
    if (!s) return { quotes: "none", prints: "none", reason: "not subscribed" };
    const p = s.parts;
    return {
      quotes: s.bid > 0 && s.ask > 0 ? (s.delayed ? "delayed" : "live") : "none",
      prints: p.prints.stop && !p.prints.issue ? "live" : "none",
      reason: p.quotes.issue ?? p.prints.issue ?? p.depth.issue,
    };
  }

  /** Front contract by our roll calendar, then IBKR's contract details for the conId and the exchange's real last trade date (covers holidays). */
  async resolve(root: Root, at = new Date()): Promise<FuturesContract> {
    const c = frontContract(root, at);
    const details = await this.api.getContractDetails(toIbContract(c));
    const d = details[0];
    if (!d?.contract.conId) throw new Error(`IBKR has no contract for ${c.code} (${c.month})`);
    if (details.length > 1) console.warn(`ibkr: ${details.length} matches for ${c.code}; using conId ${d.contract.conId}`);
    const lastTrade = parseIbDate(d.contract.lastTradeDateOrContractMonth);
    return { ...c, brokerId: d.contract.conId, calendar: lastTrade ? { ...c.calendar, lastTradeDate: lastTrade } : c.calendar };
  }

  async subscribe(contract: FuturesContract, opts: { depthRows?: number } = {}) {
    if (this.streams.has(contract.code)) return;
    const part = (): Part => ({ stop: null, issue: null, retry: null });
    const s: Stream = {
      contract, depthRows: opts.depthRows ?? 0, bid: NaN, ask: NaN, bidSize: 0, askSize: 0, last: null, bids: [], asks: [],
      delayed: false, parts: { quotes: part(), prints: part(), depth: part() }, onBook: new Set(), onPrint: new Set(),
    };
    this.streams.set(contract.code, s);
    this.start(s, "quotes");
    this.start(s, "prints");
    if (s.depthRows) this.start(s, "depth");
  }

  unsubscribe(contract: FuturesContract) {
    const s = this.streams.get(contract.code);
    if (s) this.stopAll(s);
    this.streams.delete(contract.code);
  }

  book(contract: FuturesContract): BookSnapshot | null {
    const s = this.streams.get(contract.code);
    return s ? snapshot(s) : null;
  }

  onBook(contract: FuturesContract, cb: (b: BookSnapshot) => void) {
    const s = this.mustStream(contract);
    s.onBook.add(cb);
    return () => { s.onBook.delete(cb); };
  }

  onPrint(contract: FuturesContract, cb: (p: Print) => void) {
    const s = this.mustStream(contract);
    s.onPrint.add(cb);
    return () => { s.onPrint.delete(cb); };
  }

  async bars(contract: FuturesContract, size: BarSize, lookback: string): Promise<Bar[]> {
    // formatDate 2: bar time as epoch seconds. useRTH false: futures trade overnight, keep the whole Globex session.
    const raw = await this.api.getHistoricalData(toIbContract(contract), undefined, lookback, BAR_SIZES[size], WhatToShow.TRADES, false, 2);
    return raw
      .filter((b) => b.time && b.close !== undefined)
      .map((b) => ({ ts: Number(b.time) * 1000, open: b.open!, high: b.high!, low: b.low!, close: b.close!, volume: b.volume ?? 0 }));
  }

  /**
   * Up to `count` (IBKR caps it at 1000) historical bid/ask changes from `startMs`, oldest first. IBKR stamps them
   * to the whole second. Needs the same market data subscription as live quotes, and is paced by IBKR (roughly 60
   * historical requests per 10 minutes), so callers should wait between pages.
   */
  historicalQuotes(contract: FuturesContract, startMs: number, count = 1000) {
    return lastOf<HistoricalTickBidAsk[]>(this.api.getHistoricalTicksBidAsk(toIbContract(contract), ibUtc(startMs), undefined, count, false, false))
      .then((ticks) => ticks.filter((t) => t.time && t.priceBid && t.priceAsk)
        .map((t) => ({ t: t.time! * 1000, b: t.priceBid!, a: t.priceAsk!, bs: t.sizeBid ?? 0, as: t.sizeAsk ?? 0 })));
  }

  /** Up to `count` historical trades from `startMs`, oldest first, stamped to the whole second. Same pacing as quotes. */
  historicalTrades(contract: FuturesContract, startMs: number, count = 1000) {
    return lastOf<HistoricalTickLast[]>(this.api.getHistoricalTicksLast(toIbContract(contract), ibUtc(startMs), undefined, count, false))
      .then((ticks) => ticks.filter((t) => t.time && t.price && t.size).map((t) => ({ t: t.time! * 1000, p: t.price!, s: t.size! })));
  }

  private start(s: Stream, name: PartName) {
    const ib = toIbContract(s.contract);
    const error = (e: unknown) => this.fail(s, name, e);
    let sub: { unsubscribe(): void };
    if (name === "quotes") {
      sub = this.api.getMarketData(ib, "", false, false).subscribe({
        next: ({ all }) => {
          const v = (live: Tick, delayed: Tick) => (all.get(live) ?? all.get(delayed))?.value;
          if (all.has(Tick.BID) || all.has(Tick.ASK)) s.delayed = false;
          else if (all.has(Tick.DELAYED_BID) || all.has(Tick.DELAYED_ASK)) s.delayed = true;
          s.bid = v(Tick.BID, Tick.DELAYED_BID) ?? s.bid;
          s.ask = v(Tick.ASK, Tick.DELAYED_ASK) ?? s.ask;
          s.bidSize = v(Tick.BID_SIZE, Tick.DELAYED_BID_SIZE) ?? s.bidSize;
          s.askSize = v(Tick.ASK_SIZE, Tick.DELAYED_ASK_SIZE) ?? s.askSize;
          s.last = v(Tick.LAST, Tick.DELAYED_LAST) ?? s.last;
          this.recovered(s, "quotes");
          this.publish(s);
        },
        error,
      });
    } else if (name === "prints") {
      sub = this.api.getTickByTickAllLastDataUpdates(ib, 0, false).subscribe({
        next: (t) => {
          if (t.price === undefined || !t.size) return;
          this.recovered(s, "prints");
          const side = t.price >= s.ask ? "buy" : t.price <= s.bid ? "sell" : null;
          const p: Print = { ts: t.time * 1000, price: t.price, size: t.size, side };
          s.onPrint.forEach((cb) => cb(p));
        },
        error,
      });
    } else {
      sub = this.api.getMarketDepth(ib, s.depthRows, false).subscribe({
        next: ({ all }) => {
          s.bids = rows(all.bids);
          s.asks = rows(all.asks);
          this.recovered(s, "depth");
          this.publish(s);
        },
        error,
      });
    }
    // A stream can fail synchronously inside subscribe(); only record the stop handle if it is still live.
    if (!s.parts[name].retry) s.parts[name].stop = () => sub.unsubscribe();
  }

  /** A stream ended with an error: explain it (once per distinct reason), stop trading on its data, retry later. */
  private fail(s: Stream, name: PartName, e: unknown) {
    const part = s.parts[name];
    part.stop = null;
    const problem = explain(name, s.contract, e);
    if (part.issue !== problem.reason) this.log(`${problem.explain} Retrying every ${Math.round(this.retryMs / 1000)}s.`);
    part.issue = problem.reason;
    if (name === "quotes") { s.bid = NaN; s.ask = NaN; } // never serve a stale book
    if (name === "depth") { s.bids = []; s.asks = []; }
    if (part.retry) clearTimeout(part.retry);
    part.retry = setTimeout(() => {
      part.retry = null;
      if (this.streams.get(s.contract.code) === s && !part.stop) this.start(s, name);
    }, this.retryMs);
  }

  private recovered(s: Stream, name: PartName) {
    const part = s.parts[name];
    if (!part.issue) return;
    this.log(`${s.contract.code} ${name} flowing again${name === "quotes" && s.delayed ? " (delayed)" : ""}.`);
    part.issue = null;
  }

  private stopAll(s: Stream) {
    for (const part of Object.values(s.parts)) {
      part.stop?.();
      part.stop = null;
      if (part.retry) clearTimeout(part.retry);
      part.retry = null;
    }
  }

  private publish(s: Stream) {
    const b = snapshot(s);
    if (b) s.onBook.forEach((cb) => cb(b));
  }

  private mustStream(contract: FuturesContract) {
    const s = this.streams.get(contract.code);
    if (!s) throw new Error(`${contract.code} is not subscribed`);
    return s;
  }
}

/** Turn an IBKR stream error into a short reason and a plain explanation with the fix. */
export function explain(name: PartName, c: FuturesContract, e: unknown): Problem {
  const err = e as { code?: number; error?: Error } | undefined;
  const code = err?.code;
  const msg = err?.error?.message ?? String(e);
  const exch = SPECS[c.root].exchange;
  const tag = code ? ` (${code})` : "";
  if (code === 10197 || /competing live session/i.test(msg)) {
    return {
      reason: `competing live session${tag}`,
      explain: `${c.code}: IBKR is sending real-time data to another session on the live account (TWS, mobile or web). Log out there; only one session gets real-time data.`,
    };
  }
  if (name === "quotes" && (code === 354 || code === 10090 || /not subscribed/i.test(msg))) {
    return {
      reason: `no real-time ${exch} data${tag}`,
      explain: `${c.code}: this IBKR login has no real-time ${exch} market data${tag}. In Client Portal, logged in as the live user: Settings, Market Data Subscriptions, add ${exch} real-time L1 (non-professional); then Settings, Paper Trading Account, share market data with the paper account. It can take until the next day. Meanwhile IB_MARKET_DATA_TYPE=3 gives free 15 minute delayed data (simulation only).`,
    };
  }
  if (name === "prints") {
    return {
      reason: `no tick-by-tick trades${tag}`,
      explain: `${c.code}: tick-by-tick trades are unavailable${tag}. They need a real-time ${exch} subscription; delayed data has none. Trading continues with the trade flow inputs empty.`,
    };
  }
  if (name === "depth") {
    return { reason: `no market depth${tag}`, explain: `${c.code}: market depth is unavailable${tag}: ${msg}. It needs the ${exch} depth-of-book subscription; using the top of book only.` };
  }
  return { reason: `${name} stream ended${tag}`, explain: `${c.code}: ${name} stream ended${tag}: ${msg}.` };
}

function snapshot(s: Stream): BookSnapshot | null {
  if (!(s.bid > 0 && s.ask > 0)) return null;
  const spec = SPECS[s.contract.root];
  const bids = s.bids.length ? s.bids : [{ price: s.bid, size: s.bidSize }];
  const asks = s.asks.length ? s.asks : [{ price: s.ask, size: s.askSize }];
  const bd = bids.reduce((a, l) => a + l.size, 0), ad = asks.reduce((a, l) => a + l.size, 0);
  return {
    contract: s.contract.code, ts: Date.now(),
    bid: s.bid, ask: s.ask, bidSize: s.bidSize, askSize: s.askSize,
    mid: (s.bid + s.ask) / 2,
    spreadTicks: toTicks(spec, s.ask) - toTicks(spec, s.bid),
    imbalance: bd + ad ? (bd - ad) / (bd + ad) : 0,
    levels: { bids: s.bids, asks: s.asks },
    last: s.last,
    delayed: s.delayed,
  };
}

/** IBKR's UTC date-time form for historical requests: yyyymmdd-hh:mm:ss. */
const ibUtc = (ms: number) => new Date(ms).toISOString().replace(/-/g, "").replace("T", "-").slice(0, 17);

/** Last value an observable emits before it completes (IBKR historical requests emit the growing list). */
function lastOf<T>(obs: { subscribe(o: { next: (v: T) => void; error: (e: unknown) => void; complete: () => void }): { unsubscribe(): void } }, timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let last: T | undefined;
    const timer = setTimeout(() => { sub.unsubscribe(); reject(new Error(`historical request timed out after ${timeoutMs} ms`)); }, timeoutMs);
    const sub = obs.subscribe({
      next: (v) => { last = v; },
      error: (e) => { clearTimeout(timer); reject(new Error((e as { error?: Error })?.error?.message ?? String(e))); },
      complete: () => { clearTimeout(timer); resolve(last ?? ([] as T)); },
    });
  });
}

const rows = (r: OrderBookRows): BookLevel[] =>
  [...r.entries()].sort(([a], [b]) => a - b).map(([, row]) => ({ price: row.price, size: row.size }));
