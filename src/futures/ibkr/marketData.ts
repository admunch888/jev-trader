import { BarSizeSetting, ConnectionState, IBApiNext, IBApiTickType as Tick, WhatToShow, type HistoricalTickBidAsk, type HistoricalTickLast, type MarketDataType, type OrderBookRows } from "@stoqey/ib";
import { frontContract, SPECS, toTicks } from "../contracts";
import type { Bar, BarSize, BookLevel, BookSnapshot, FeedStatus, FuturesContract, MarketData, Print, Root } from "../types";
import { ibConfig } from "./config";
import { parseIbDate, toIbContract, until } from "./contract";

interface Stream {
  contract: FuturesContract;
  bid: number; ask: number; bidSize: number; askSize: number; last: number | null;
  bids: BookLevel[]; asks: BookLevel[];
  delayed: boolean;
  unsub: (() => void)[];
  onBook: Set<(b: BookSnapshot) => void>;
  onPrint: Set<(p: Print) => void>;
}

const BAR_SIZES: Record<BarSize, BarSizeSetting> = { "5s": BarSizeSetting.SECONDS_FIVE, "1m": BarSizeSetting.MINUTES_ONE, "5m": BarSizeSetting.MINUTES_FIVE };

/**
 * IBKR market data over TWS / IB Gateway, via IBApiNext (auto-reconnect, streams survive reconnects).
 *
 * Top of book: reqMktData. Prints: tick-by-tick AllLast, aggressor inferred from the quote in force. Depth:
 * reqMktDepth, which needs a paid CME/CBOT depth subscription and counts against IBKR's depth-line limit, so it
 * is opt-in per contract. IBKR samples top of book (a few updates a second) rather than sending every change, so
 * this is fine for decisions on a scale of seconds, not for queue-position market making.
 */
export class IbkrMarketData implements MarketData {
  private api = new IBApiNext({ host: ibConfig.host, port: ibConfig.port, reconnectInterval: ibConfig.reconnectMs });
  private streams = new Map<string, Stream>();
  private _status: FeedStatus = "disconnected";

  get status() { return this._status; }

  async connect() {
    this.api.connectionState.subscribe((s) => {
      this._status = s === ConnectionState.Connected ? "connected" : s === ConnectionState.Connecting ? "connecting" : "disconnected";
    });
    this.api.error.subscribe((e) => console.warn(`ibkr md: ${e.code} ${e.error.message}`));
    this.api.connect(ibConfig.clientId);
    await until(() => this._status === "connected", ibConfig.requestTimeoutMs, "IBKR market data connection");
    this.api.setMarketDataType(ibConfig.marketDataType as MarketDataType);
  }

  async close() {
    for (const s of this.streams.values()) s.unsub.forEach((u) => u());
    this.streams.clear();
    this.api.disconnect();
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
    const ib = toIbContract(contract);
    const s: Stream = {
      contract, bid: NaN, ask: NaN, bidSize: 0, askSize: 0, last: null, bids: [], asks: [], delayed: false,
      unsub: [], onBook: new Set(), onPrint: new Set(),
    };
    this.streams.set(contract.code, s);

    const top = this.api.getMarketData(ib, "", false, false).subscribe({
      next: ({ all }) => {
        const v = (live: Tick, delayed: Tick) => {
          const t = all.get(live) ?? all.get(delayed);
          if (all.get(live) === undefined && t) s.delayed = true;
          return t?.value;
        };
        s.bid = v(Tick.BID, Tick.DELAYED_BID) ?? s.bid;
        s.ask = v(Tick.ASK, Tick.DELAYED_ASK) ?? s.ask;
        s.bidSize = v(Tick.BID_SIZE, Tick.DELAYED_BID_SIZE) ?? s.bidSize;
        s.askSize = v(Tick.ASK_SIZE, Tick.DELAYED_ASK_SIZE) ?? s.askSize;
        s.last = v(Tick.LAST, Tick.DELAYED_LAST) ?? s.last;
        this.publish(s);
      },
      error: (e) => console.warn(`ibkr md ${contract.code}: top of book stream ended: ${e?.error?.message ?? e}`),
    });
    s.unsub.push(() => top.unsubscribe());

    const prints = this.api.getTickByTickAllLastDataUpdates(ib, 0, false).subscribe({
      next: (t) => {
        if (t.price === undefined || !t.size) return;
        const side = t.price >= s.ask ? "buy" : t.price <= s.bid ? "sell" : null;
        const p: Print = { ts: t.time * 1000, price: t.price, size: t.size, side };
        s.onPrint.forEach((cb) => cb(p));
      },
      error: (e) => console.warn(`ibkr md ${contract.code}: tick-by-tick stream ended: ${e?.error?.message ?? e}`),
    });
    s.unsub.push(() => prints.unsubscribe());

    if (opts.depthRows) {
      const depth = this.api.getMarketDepth(ib, opts.depthRows, false).subscribe({
        next: ({ all }) => {
          s.bids = rows(all.bids);
          s.asks = rows(all.asks);
          this.publish(s);
        },
        error: (e) => console.warn(`ibkr md ${contract.code}: depth stream ended (depth subscription?): ${e?.error?.message ?? e}`),
      });
      s.unsub.push(() => depth.unsubscribe());
    }
  }

  unsubscribe(contract: FuturesContract) {
    const s = this.streams.get(contract.code);
    s?.unsub.forEach((u) => u());
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
