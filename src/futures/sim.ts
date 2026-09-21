import { frontContract, onTick, pnlUsd, SPECS, toTicks } from "./contracts";
import type {
  AccountState, Bar, BarSize, BookSnapshot, BrokerPosition, ExecFill, Execution, FeedStatus, FuturesContract,
  MarketData, OrderRequest, OrderState, OrderUpdate, Print, Root, WhatIf,
} from "./types";

/**
 * Simulated order routing against any `MarketData`: with `IbkrMarketData` it paper-trades the real book without
 * sending anything (FUT_EXEC=sim); with `ManualMarketData` it drives the tests.
 *
 * Fill rules, deliberately simple and optimistic about size (whole order, no queue, no partials):
 *   market             fills at the touch
 *   limit, marketable  fills at the touch (a buy limit at or above the ask fills at the ask)
 *   limit, otherwise   IOC cancels; DAY/GTC rests and fills at its price once the touch reaches it
 *   stop               triggers when the touch reaches it (buy stop: ask >= stop) and fills at the touch
 * Fees are the spec's `estFeesPerSide` per contract. Updates and fills are delivered asynchronously, status
 * first and fill second, which is the awkward order the trader must handle with IBKR too.
 */
export class SimExecution implements Execution {
  private seq = 0;
  private orders = new Map<string, { id: number; req: OrderRequest; state: OrderState }>();
  private pos = new Map<string, { root: Root; qty: number; costUsd: number }>();
  private realizedUsd = 0;
  private feesUsd = 0;
  private watching = new Set<string>();
  private orderCbs = new Set<(u: OrderUpdate) => void>();
  private fillCbs = new Set<(f: ExecFill) => void>();

  constructor(private md: MarketData, private startingCashUsd = 10_000) {}

  async connect() {}
  async close() {}

  async place(req: OrderRequest): Promise<number> {
    if (req.bracket) throw new Error("SimExecution does not simulate brackets");
    if (!Number.isInteger(req.qty) || req.qty <= 0) throw new Error(`${req.ref}: bad qty ${req.qty}`);
    if (req.kind !== "market" && (req.price === undefined || !onTick(SPECS[req.contract.root], req.price))) throw new Error(`${req.ref}: price off tick`);
    if (this.orders.has(req.ref)) throw new Error(`duplicate order ref ${req.ref}`);
    const o = { id: ++this.seq, req, state: "pending" as OrderState };
    this.orders.set(req.ref, o);
    this.watch(req.contract);
    later(() => {
      const b = this.md.book(req.contract);
      if (!b) return this.finish(o, "rejected", "no quote");
      if (!this.tryFill(o, b)) {
        if (req.tif === "ioc") return this.finish(o, "cancelled");
        o.state = "working";
        this.emitOrder(o, 0);
      }
    });
    return o.id;
  }

  async modify(ref: string, change: { price?: number; qty?: number }) {
    const o = this.orders.get(ref);
    if (!o || o.state !== "working") throw new Error(`order ${ref} is not working`);
    o.req = { ...o.req, price: change.price ?? o.req.price, qty: change.qty ?? o.req.qty };
    later(() => {
      const b = this.md.book(o.req.contract);
      if (!(b && this.tryFill(o, b))) this.emitOrder(o, 0);
    });
  }

  async cancel(ref: string) {
    const o = this.orders.get(ref);
    if (o && (o.state === "working" || o.state === "pending")) later(() => { if (o.state === "working" || o.state === "pending") this.finish(o, "cancelled"); });
  }

  async cancelAll() {
    for (const ref of this.orders.keys()) await this.cancel(ref);
  }

  async whatIf(req: OrderRequest): Promise<WhatIf> {
    return { initMarginChange: 0, maintMarginChange: 0, commission: SPECS[req.contract.root].estFeesPerSide * req.qty };
  }

  async positions(): Promise<BrokerPosition[]> {
    return [...this.pos].filter(([, p]) => p.qty).map(([contract, p]) => ({ contract, qty: p.qty, avgPrice: p.costUsd / p.qty / SPECS[p.root].multiplier }));
  }

  async account(): Promise<AccountState> {
    let unrealized = 0;
    for (const [code, p] of this.pos) {
      if (!p.qty) continue;
      const b = this.md.book(frontLike(p.root, code));
      if (b) unrealized += p.qty * b.mid * SPECS[p.root].multiplier - p.costUsd;
    }
    const nl = this.startingCashUsd + this.realizedUsd + unrealized - this.feesUsd;
    return { netLiquidation: nl, availableFunds: nl, initMargin: 0, maintMargin: 0 };
  }

  onOrder(cb: (u: OrderUpdate) => void) { this.orderCbs.add(cb); return () => { this.orderCbs.delete(cb); }; }
  onFill(cb: (f: ExecFill) => void) { this.fillCbs.add(cb); return () => { this.fillCbs.delete(cb); }; }

  private watch(c: FuturesContract) {
    if (this.watching.has(c.code)) return;
    this.watching.add(c.code);
    this.md.onBook(c, (b) => {
      for (const o of this.orders.values()) if (o.state === "working" && o.req.contract.code === b.contract) this.tryFill(o, b);
    });
  }

  /** Fills the whole order if the book allows it now. */
  private tryFill(o: { req: OrderRequest; state: OrderState; id: number }, b: BookSnapshot): boolean {
    const { side, kind, price } = o.req;
    const touch = side === "buy" ? b.ask : b.bid;
    let fillAt: number | null = null;
    if (kind === "market") fillAt = touch;
    else if (kind === "limit") {
      if (side === "buy" ? b.ask <= price! : b.bid >= price!) fillAt = o.state === "working" ? price! : touch;
    } else if (side === "buy" ? b.ask >= price! : b.bid <= price!) fillAt = touch;
    if (fillAt === null) return false;
    this.finish(o, "filled", undefined, fillAt);
    return true;
  }

  private finish(o: { id: number; req: OrderRequest; state: OrderState }, state: OrderState, reason?: string, fillAt?: number) {
    o.state = state;
    const filled = state === "filled" ? o.req.qty : 0;
    this.emitOrder(o, filled, reason, fillAt);
    if (fillAt === undefined) return;
    const { req } = o;
    const spec = SPECS[req.contract.root];
    const commission = spec.estFeesPerSide * req.qty;
    this.book(req.contract, req.side === "buy" ? req.qty : -req.qty, fillAt, commission);
    const fill: ExecFill = { ref: req.ref, execId: `sim-${o.id}`, contract: req.contract.code, side: req.side, qty: req.qty, price: fillAt, ts: Date.now(), commission };
    later(() => this.fillCbs.forEach((cb) => cb(fill)));
  }

  private emitOrder(o: { id: number; req: OrderRequest; state: OrderState }, filled: number, reason?: string, avg?: number) {
    const u: OrderUpdate = {
      ref: o.req.ref, brokerId: o.id, state: o.state, filled, remaining: o.req.qty - filled,
      avgPrice: avg ?? null, ts: Date.now(), ...(reason ? { reason } : {}),
    };
    this.orderCbs.forEach((cb) => cb(u));
  }

  private book(c: FuturesContract, signed: number, price: number, fee: number) {
    const spec = SPECS[c.root];
    const p = this.pos.get(c.code) ?? { root: c.root, qty: 0, costUsd: 0 };
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

/**
 * A `MarketData` driven by hand: `setQuote` and `print` push data to subscribers. Used by the tests and as the
 * seam for a replay feed.
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
  async subscribe() {}
  unsubscribe(c: FuturesContract) { this.bookCbs.delete(c.code); this.printCbs.delete(c.code); }
  book(c: FuturesContract) { return this.books.get(c.code) ?? null; }
  onBook(c: FuturesContract, cb: (b: BookSnapshot) => void) { return add(this.bookCbs, c.code, cb); }
  onPrint(c: FuturesContract, cb: (p: Print) => void) { return add(this.printCbs, c.code, cb); }
  async bars(c: FuturesContract, _size: BarSize, _lookback: string) { return this.seeded.get(c.code) ?? []; }

  seedBars(c: FuturesContract, bars: Bar[]) { this.seeded.set(c.code, bars); }

  setQuote(c: FuturesContract, bid: number, ask: number, extra: { bidSize?: number; askSize?: number; delayed?: boolean } = {}) {
    const spec = SPECS[c.root];
    const bidSize = extra.bidSize ?? 10, askSize = extra.askSize ?? 10;
    const b: BookSnapshot = {
      contract: c.code, ts: Date.now(), bid, ask, bidSize, askSize, mid: (bid + ask) / 2,
      spreadTicks: toTicks(spec, ask) - toTicks(spec, bid),
      imbalance: (bidSize - askSize) / (bidSize + askSize),
      levels: { bids: [], asks: [] }, last: null, delayed: extra.delayed ?? false,
    };
    this.books.set(c.code, b);
    this.bookCbs.get(c.code)?.forEach((cb) => cb(b));
  }

  print(c: FuturesContract, p: Print) { this.printCbs.get(c.code)?.forEach((cb) => cb(p)); }
}

function add<T>(m: Map<string, Set<T>>, k: string, v: T) {
  const s = m.get(k) ?? new Set<T>();
  s.add(v);
  m.set(k, s);
  return () => { s.delete(v); };
}

const later = (fn: () => void) => { setTimeout(fn, 0); };
/** Enough of a contract to look its book up by code. */
const frontLike = (root: Root, code: string): FuturesContract => ({ ...frontContract(root), code });
