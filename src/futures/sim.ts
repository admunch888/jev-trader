import { frontContract, onTick, pnlUsd, SPECS, toTicks } from "./contracts";
import type {
  AccountState, Bar, BarSize, BookSnapshot, BrokerPosition, ExecFill, Execution, FeedStatus, FuturesContract,
  MarketData, OrderRequest, OrderState, OrderUpdate, Print, Root, WhatIf,
} from "./types";

export interface SimOptions {
  startingCashUsd?: number;
  /** Clock for order and fill timestamps and for latency. The backtest passes its replay clock. */
  now?: () => number;
  /** How status and fill messages are delivered. Default setTimeout(0); the backtest uses microtasks. */
  defer?: (fn: () => void) => void;
  /**
   * Places, modifies and cancels reach the simulated exchange this long after they are sent, and are matched
   * against the book as it is then. 0 (live sim) means on the next tick. Due operations run from `processDue`,
   * which the backtest calls as its clock advances.
   */
  latencyMs?: number;
  /** Marketable orders fill at most the size shown at the touch; the rest of an IOC or market order is cancelled. */
  respectSize?: boolean;
}

interface SimOrder { id: number; req: OrderRequest; state: OrderState; filled: number }

/**
 * Simulated order routing against any `MarketData`: with `IbkrMarketData` it paper-trades the real book without
 * sending anything (FUT_EXEC=sim); with `ReplayMarketData` it is the backtest's exchange; with `ManualMarketData`
 * it drives the tests.
 *
 * Fill rules (no queue model, so resting limits are optimistic):
 *   market             fills at the touch
 *   limit, marketable  fills at the touch (a buy limit at or above the ask fills at the ask)
 *   limit, otherwise   IOC cancels; DAY/GTC rests and fills at its price once the touch reaches it
 *   stop               triggers when the touch reaches it (buy stop: ask >= stop) and fills at that touch, so gaps slip
 * Orders sharing an `oca` group: once one fills, the others still working are cancelled at once.
 * With `respectSize`, marketable fills are capped at the displayed touch size. Fees are the spec's
 * `estFeesPerSide` per contract. Status messages go out before their fills, the awkward order IBKR also uses.
 */
export class SimExecution implements Execution {
  private seq = 0;
  private orders = new Map<string, SimOrder>();
  private pos = new Map<string, { contract: FuturesContract; qty: number; costUsd: number }>();
  private due: { at: number; seq: number; fn: () => void }[] = [];
  private opSeq = 0;
  private realizedUsd = 0;
  private feesUsd = 0;
  private watching = new Set<string>();
  private orderCbs = new Set<(u: OrderUpdate) => void>();
  private fillCbs = new Set<(f: ExecFill) => void>();
  private readonly now: () => number;
  private readonly defer: (fn: () => void) => void;
  private readonly latencyMs: number;
  /** Bumped whenever something happens that listeners have not seen yet; the backtest flushes when it moves. */
  activity = 0;

  constructor(private md: MarketData, private opts: SimOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.defer = opts.defer ?? ((fn) => { setTimeout(fn, 0); });
    this.latencyMs = opts.latencyMs ?? 0;
  }

  async connect() {}
  async close() {}

  async place(req: OrderRequest): Promise<number> {
    if (req.bracket) throw new Error("SimExecution does not simulate brackets");
    if (!Number.isInteger(req.qty) || req.qty <= 0) throw new Error(`${req.ref}: bad qty ${req.qty}`);
    if (req.kind !== "market" && (req.price === undefined || !onTick(SPECS[req.contract.root], req.price))) throw new Error(`${req.ref}: price off tick`);
    if (this.orders.has(req.ref)) throw new Error(`duplicate order ref ${req.ref}`);
    const o: SimOrder = { id: ++this.seq, req, state: "pending", filled: 0 };
    this.orders.set(req.ref, o);
    this.watch(req.contract);
    this.schedule(() => this.arrive(o));
    return o.id;
  }

  async modify(ref: string, change: { price?: number; qty?: number }) {
    const o = this.orders.get(ref);
    if (!o || isDone(o.state)) throw new Error(`order ${ref} is not working`);
    this.schedule(() => {
      if (isDone(o.state)) return;
      o.req = { ...o.req, price: change.price ?? o.req.price, qty: change.qty ?? o.req.qty };
      const b = this.md.book(o.req.contract);
      if (!(o.state !== "pending" && b && this.tryFill(o, b))) this.emitOrder(o);
    });
  }

  async cancel(ref: string) {
    const o = this.orders.get(ref);
    if (!o || isDone(o.state)) return;
    this.schedule(() => { if (!isDone(o.state)) { o.state = "cancelled"; this.emitOrder(o); } });
  }

  async cancelAll() {
    for (const ref of this.orders.keys()) await this.cancel(ref);
  }

  async whatIf(req: OrderRequest): Promise<WhatIf> {
    return { initMarginChange: 0, maintMarginChange: 0, commission: SPECS[req.contract.root].estFeesPerSide * req.qty };
  }

  async positions(): Promise<BrokerPosition[]> {
    return [...this.pos].filter(([, p]) => p.qty).map(([code, p]) => ({ contract: code, qty: p.qty, avgPrice: p.costUsd / p.qty / SPECS[p.contract.root].multiplier }));
  }

  async account(): Promise<AccountState> {
    let unrealized = 0;
    for (const p of this.pos.values()) {
      const b = p.qty ? this.md.book(p.contract) : null;
      if (b) unrealized += p.qty * b.mid * SPECS[p.contract.root].multiplier - p.costUsd;
    }
    const nl = (this.opts.startingCashUsd ?? 10_000) + this.realizedUsd + unrealized - this.feesUsd;
    return { netLiquidation: nl, availableFunds: nl, initMargin: 0, maintMargin: 0 };
  }

  onOrder(cb: (u: OrderUpdate) => void) { this.orderCbs.add(cb); return () => { this.orderCbs.delete(cb); }; }
  onFill(cb: (f: ExecFill) => void) { this.fillCbs.add(cb); return () => { this.fillCbs.delete(cb); }; }

  /** Run every operation that has reached the exchange by `atMs` (inclusive), in the order sent. */
  processDue(atMs: number) {
    if (!this.due.length || this.due[0]!.at > atMs) return;
    const ready = this.due.filter((d) => d.at <= atMs);
    this.due = this.due.filter((d) => d.at > atMs);
    for (const d of ready) d.fn();
  }

  /** Time the next queued operation reaches the exchange, if any. */
  get nextDue(): number | null { return this.due[0]?.at ?? null; }

  private schedule(fn: () => void) {
    this.activity++;
    if (!this.latencyMs) return this.defer(fn);
    this.due.push({ at: this.now() + this.latencyMs, seq: ++this.opSeq, fn });
    this.due.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  private arrive(o: SimOrder) {
    if (o.state !== "pending") return; // cancelled before it reached the exchange
    const b = this.md.book(o.req.contract);
    if (!b) { o.state = "rejected"; return this.emitOrder(o, "no quote"); }
    if (this.tryFill(o, b)) return;
    o.state = o.req.tif === "ioc" ? "cancelled" : "working";
    this.emitOrder(o);
  }

  private watch(c: FuturesContract) {
    if (this.watching.has(c.code)) return;
    this.watching.add(c.code);
    this.md.onBook(c, (b) => {
      for (const o of this.orders.values()) {
        if ((o.state === "working" || o.state === "partial") && o.req.contract.code === b.contract) this.tryFill(o, b);
      }
    });
  }

  /** Fill what the book allows now. Returns false if nothing traded. */
  private tryFill(o: SimOrder, b: BookSnapshot): boolean {
    const { side, kind, price } = o.req;
    const touch = side === "buy" ? b.ask : b.bid;
    let fillAt: number | null = null;
    let marketable = true;
    if (kind === "market") fillAt = touch;
    else if (kind === "limit") {
      if (side === "buy" ? b.ask <= price! : b.bid >= price!) {
        marketable = o.state === "pending"; // a resting limit the market came to fills at its own price
        fillAt = marketable ? touch : price!;
      }
    } else if (side === "buy" ? b.ask >= price! : b.bid <= price!) fillAt = touch;
    if (fillAt === null) return false;

    let qty = o.req.qty - o.filled;
    const shown = side === "buy" ? b.askSize : b.bidSize;
    if (this.opts.respectSize && marketable && shown > 0) qty = Math.min(qty, shown);
    this.fill(o, qty, fillAt);
    if (o.filled >= o.req.qty) o.state = "filled";
    else if (o.req.tif === "ioc" || kind !== "limit") o.state = "cancelled"; // IOC remainder, or a market/stop sweep we do not walk past the touch
    else o.state = "partial";
    this.emitOrder(o, undefined, fillAt);
    if (o.req.oca) {
      for (const other of this.orders.values()) {
        if (other !== o && other.req.oca === o.req.oca && !isDone(other.state)) { other.state = "cancelled"; this.emitOrder(other); }
      }
    }
    return true;
  }

  private fill(o: SimOrder, qty: number, price: number) {
    o.filled += qty;
    const { req } = o;
    const spec = SPECS[req.contract.root];
    const commission = spec.estFeesPerSide * qty;
    this.bookPosition(req.contract, req.side === "buy" ? qty : -qty, price, commission);
    const fill: ExecFill = { ref: req.ref, execId: `sim-${o.id}-${o.filled}`, contract: req.contract.code, side: req.side, qty, price, ts: this.now(), commission };
    this.activity++;
    this.defer(() => this.fillCbs.forEach((cb) => cb(fill)));
  }

  private emitOrder(o: SimOrder, reason?: string, avg?: number) {
    const u: OrderUpdate = {
      ref: o.req.ref, brokerId: o.id, state: o.state, filled: o.filled, remaining: o.req.qty - o.filled,
      avgPrice: avg ?? null, ts: this.now(), ...(reason ? { reason } : {}),
    };
    this.activity++;
    this.orderCbs.forEach((cb) => cb(u));
  }

  private bookPosition(c: FuturesContract, signed: number, price: number, fee: number) {
    const spec = SPECS[c.root];
    const p = this.pos.get(c.code) ?? { contract: c, qty: 0, costUsd: 0 };
    const closing = Math.sign(signed) !== Math.sign(p.qty) ? Math.min(Math.abs(signed), Math.abs(p.qty)) * Math.sign(signed) : 0;
    if (closing) {
      const entry = p.costUsd / p.qty / spec.multiplier;
      this.realizedUsd += pnlUsd(spec, -closing, entry, price);
      p.costUsd += closing * entry * spec.multiplier;
    }
    p.costUsd += (signed - closing) * price * spec.multiplier;
    p.qty += signed;
    if (!p.qty) p.costUsd = 0;
    this.feesUsd += fee;
    this.pos.set(c.code, p);
  }
}

const isDone = (s: OrderState) => s === "filled" || s === "cancelled" || s === "rejected";

/**
 * A `MarketData` driven by hand: `setQuote` and `print` push data to subscribers. Used by the tests, and
 * extended by `ReplayMarketData` for backtests.
 */
export class ManualMarketData implements MarketData {
  readonly status: FeedStatus = "connected";
  private books = new Map<string, BookSnapshot>();
  private bookCbs = new Map<string, Set<(b: BookSnapshot) => void>>();
  private printCbs = new Map<string, Set<(p: Print) => void>>();
  private seeded = new Map<string, Bar[]>();

  async connect() {}
  async close() {}
  async resolve(root: Root, at = new Date()) { return frontContract(root, at); }
  async subscribe(_c: FuturesContract, _opts?: { depthRows?: number }) {}
  unsubscribe(c: FuturesContract) { this.bookCbs.delete(c.code); this.printCbs.delete(c.code); }
  book(c: FuturesContract) { return this.books.get(c.code) ?? null; }
  onBook(c: FuturesContract, cb: (b: BookSnapshot) => void) { return add(this.bookCbs, c.code, cb); }
  onPrint(c: FuturesContract, cb: (p: Print) => void) { return add(this.printCbs, c.code, cb); }
  async bars(c: FuturesContract, _size: BarSize, _lookback: string) { return this.seeded.get(c.code) ?? []; }

  seedBars(c: FuturesContract, bars: Bar[]) { this.seeded.set(c.code, bars); }

  setQuote(c: FuturesContract, bid: number, ask: number, extra: { bidSize?: number; askSize?: number; delayed?: boolean; ts?: number } = {}) {
    const spec = SPECS[c.root];
    const bidSize = extra.bidSize ?? 10, askSize = extra.askSize ?? 10;
    const b: BookSnapshot = {
      contract: c.code, ts: extra.ts ?? Date.now(), bid, ask, bidSize, askSize, mid: (bid + ask) / 2,
      spreadTicks: toTicks(spec, ask) - toTicks(spec, bid),
      imbalance: bidSize + askSize ? (bidSize - askSize) / (bidSize + askSize) : 0,
      levels: { bids: [], asks: [] }, last: this.books.get(c.code)?.last ?? null, delayed: extra.delayed ?? false,
    };
    this.books.set(c.code, b);
    this.bookCbs.get(c.code)?.forEach((cb) => cb(b));
  }

  print(c: FuturesContract, p: Print) {
    const b = this.books.get(c.code);
    if (b) b.last = p.price;
    this.printCbs.get(c.code)?.forEach((cb) => cb(p));
  }
}

function add<T>(m: Map<string, Set<T>>, k: string, v: T) {
  const s = m.get(k) ?? new Set<T>();
  s.add(v);
  m.set(k, s);
  return () => { s.delete(v); };
}
