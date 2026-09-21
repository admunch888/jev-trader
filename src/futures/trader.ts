import { config } from "../config";
import type { Action, Model } from "../model";
import type { FuturesConfig } from "./config";
import { pnlUsd, roundToTick, SPECS } from "./contracts";
import type { FuturesTradeState } from "./model";
import { clampTarget, RiskGuard, targetFromProbability, type Gate, type Gates } from "./policy";
import type { BookSnapshot, ContractSpec, ExecFill, Execution, FuturesContract, MarketData, OrderState, OrderUpdate, Print, Root, Side } from "./types";

export interface FuturesEvent {
  root: Root;
  contract: string;
  ts: number;
  cycle: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadTicks: number | null;
  delayed: boolean;
  /** Null when the model was not asked (a gate already decided, no quote) or did not answer in time. */
  decision: { action: Action; probabilities: Record<Action, number>; latencyMs: number; late: boolean } | null;
  /** Position the model's answer asked for, before risk gates. */
  wanted: number | null;
  /** Position after risk gates; an order is sent when it differs from the current one. */
  target: number | null;
  gate: Gate | null;
  gateDetail?: string;
  order: { ref: string; side: Side; qty: number; price: number } | null;
  position: { qty: number; avgPrice: number | null; unrealizedUsd: number };
  stop: { price: number; qty: number; state: OrderState } | null;
  totals: Totals;
  halted: string | null;
  notes: string[];
}

export interface Totals {
  cycles: number;
  decisions: number;
  late: number;
  timeouts: number;
  orders: number;
  fills: number;
  rejects: number;
  realizedUsd: number;
  feesUsd: number;
  jevUsd: number;
  /** realized + unrealized - fees. Jev cost is reported separately. */
  pnlUsd: number;
  pnlTodayUsd: number;
}

export interface TraderDeps {
  root: Root;
  md: MarketData;
  ex: Execution;
  model: Model<FuturesTradeState>;
  guard: RiskGuard;
  cfg: FuturesConfig;
  /** True when `ex` routes to a real broker (paper or live). Delayed data then blocks new risk. */
  liveOrders: boolean;
  now?: () => Date;
  onEvent?: (e: FuturesEvent) => void;
  onFill?: (f: ExecFill, e: { root: Root; qty: number; avgPrice: number | null }) => void;
  log?: (msg: string) => void;
}

interface Tracked {
  ref: string;
  role: "entry" | "stop";
  side: Side;
  qty: number;
  price: number;
  state: OrderState;
  /** Filled quantity per the broker's order status. */
  reported: number;
  /** Filled quantity we have applied from fills. The order is settled once it is final and these agree. */
  applied: number;
  sentAt: number;
  cancelling: boolean;
}

const TERMINAL: OrderState[] = ["filled", "cancelled", "rejected"];
const isTerminal = (s: OrderState) => TERMINAL.includes(s);
const HISTORY_MS = 2 * 3_600_000;
const CHICAGO_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * One root, one contract at a time. Every `decisionSeconds`:
 *
 *   1. settle bookkeeping: expire stuck orders, roll to the next contract once flat past the roll date,
 *      roll the trading day, reconcile with the broker every `reconcileEveryCycles`
 *   2. read the book from memory (no round trip), work out the risk gates
 *   3. unless a gate already forces the answer, ask the model buy or sell for the next `horizonMinutes`
 *   4. probability -> target position (`targetFromProbability`), then `clampTarget` applies the gates
 *   5. if the target differs from the position and nothing is in flight: one IOC limit at the touch for the difference
 *   6. keep one protective GTC stop for the whole position, `stopTicks` from the average entry
 *
 * Position and PnL come from fills. One cycle runs at a time; a cycle that comes due while the last is still
 * running is recorded as late and skipped, as in the Monad loop.
 */
export class FuturesTrader {
  readonly history: FuturesEvent[] = [];
  contract!: FuturesContract;
  private readonly spec: ContractSpec;
  private readonly now: () => Date;
  private busy = false;
  private stopBusy = false;
  private cycleNo = 0;
  private refSeq = 0;
  private pos = { qty: 0, avg: 0 };
  private mids: { ts: number; mid: number }[] = [];
  private prints: Print[] = [];
  private orders = new Map<string, Tracked>();
  private offContract: (() => void)[] = [];
  private offBroker: (() => void)[] = [];
  private day: string | null = null;
  private dayStartPnl = 0;
  private needReconcile = false;
  private totals: Totals = { cycles: 0, decisions: 0, late: 0, timeouts: 0, orders: 0, fills: 0, rejects: 0, realizedUsd: 0, feesUsd: 0, jevUsd: 0, pnlUsd: 0, pnlTodayUsd: 0 };

  constructor(private d: TraderDeps) {
    this.spec = SPECS[d.root];
    this.now = d.now ?? (() => new Date());
  }

  get position() { return { qty: this.pos.qty, avgPrice: this.pos.qty ? this.pos.avg : null }; }

  async start() {
    this.contract = await this.d.md.resolve(this.d.root, this.now());
    await this.attach();
    this.offBroker.push(this.d.ex.onOrder((u) => this.onOrder(u)), this.d.ex.onFill((f) => this.onFill(f)));
    await this.reconcile("startup");
  }

  stop() {
    this.offContract.forEach((f) => f());
    this.offBroker.forEach((f) => f());
  }

  /** One decision cycle. Safe to call on a timer: overlapping calls are counted late and skipped. */
  async cycle() {
    this.cycleNo++;
    this.totals.cycles++;
    if (this.busy) {
      this.totals.late++;
      this.emit({ book: this.d.md.book(this.contract), notes: ["previous cycle still running"], late: true });
      return;
    }
    this.busy = true;
    try {
      await this.step();
    } catch (e) {
      this.log(`cycle ${this.cycleNo} failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Send an order to go flat now (shutdown). Stops stay working until the fill lands. */
  async flatten() {
    const book = this.d.md.book(this.contract);
    if (this.pos.qty && book && !this.hasUnsettledEntry()) await this.sendTowards(0, book);
  }

  // ---------------------------------------------------------------------------------------------------------

  private async step() {
    const now = this.now();
    const notes: string[] = [];
    this.expireStale(now.getTime(), notes);

    if (now >= this.contract.calendar.rollDate && this.pos.qty === 0 && !this.orders.size) await this.rollOver(now, notes);

    const book = this.d.md.book(this.contract);
    if (!book) return this.emit({ book: null, notes: [...notes, "no quote"] });
    this.recordMid(now.getTime(), book.mid);
    this.markDay(now, book);

    if (this.needReconcile || this.cycleNo % this.d.cfg.reconcileEveryCycles === 0) await this.reconcile("periodic", notes);

    const gates = this.gates(now, book);
    const forced = gates.halted || gates.roll || gates.weekend || gates.stopBreached || gates.closed;
    let decision: FuturesEvent["decision"] = null;
    let wanted: number | null = null;
    if (!forced) {
      const d = await this.decide(this.buildState(now, book, gates));
      if (d) {
        decision = { action: d.action, probabilities: d.probabilities, latencyMs: Math.round(d.latencyMs), late: false };
        wanted = targetFromProbability(d.probabilities.buy, this.pos.qty, this.d.cfg);
      } else notes.push("model gave no answer in time; holding");
    }
    const { target, gate, detail } = clampTarget(wanted ?? this.pos.qty, this.pos.qty, gates);

    let order: FuturesEvent["order"] = null;
    if (target !== this.pos.qty) {
      if (this.hasUnsettledEntry()) notes.push("previous order still settling");
      else order = await this.sendTowards(target, book);
    }
    await this.maintainStop(book);
    this.emit({ book, decision, wanted, target, gate, gateDetail: detail, order, notes });
  }

  private gates(now: Date, book: BookSnapshot): Gates {
    const cfg = this.d.cfg;
    const close = this.spec.session.nextClose(now);
    const noNewRisk: string[] = [];
    if (close && close.minutes <= cfg.entryCutoffMinutes) noNewRisk.push(`${close.minutes} min to close`);
    if (book.spreadTicks > cfg.maxSpreadTicks) noNewRisk.push(`spread ${book.spreadTicks} ticks`);
    if (book.delayed && this.d.liveOrders) noNewRisk.push("delayed data");
    if (this.d.md.status !== "connected") noNewRisk.push(`feed ${this.d.md.status}`);
    return {
      halted: !!this.d.guard.halted,
      roll: now >= this.contract.calendar.rollDate,
      weekend: !!close?.weekend && close.minutes <= cfg.flattenBeforeWeekendMinutes,
      stopBreached: this.stopBreached(book),
      closed: !close,
      noNewRisk,
      maxContracts: cfg.maxContracts,
    };
  }

  private async decide(state: FuturesTradeState) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), this.d.cfg.modelTimeoutMs); });
    try {
      const d = await Promise.race([this.d.model.decide(state), timeout]);
      if (!d) { this.totals.timeouts++; return null; }
      this.totals.decisions++;
      if (this.d.model.name !== "mock") this.totals.jevUsd += (d.inputTokens / 1e6) * config.jevUsdPerMTok;
      return d;
    } catch (e) {
      this.log(`model error: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One IOC limit at the touch (plus `slipTicks`) for the whole difference. Reducing orders first pull the stop so both cannot fill. */
  private async sendTowards(target: number, book: BookSnapshot): Promise<FuturesEvent["order"]> {
    const delta = target - this.pos.qty;
    const side: Side = delta > 0 ? "buy" : "sell";
    const qty = Math.abs(delta);
    const slip = this.d.cfg.slipTicks * this.spec.tickSize;
    const price = roundToTick(this.spec, side === "buy" ? book.ask + slip : book.bid - slip);
    if (this.pos.qty && Math.sign(delta) !== Math.sign(this.pos.qty)) {
      const stop = this.workingStop();
      if (stop) await this.cancelOrder(stop);
    }
    const ref = this.nextRef("e");
    this.orders.set(ref, { ref, role: "entry", side, qty, price, state: "pending", reported: 0, applied: 0, sentAt: this.now().getTime(), cancelling: false });
    try {
      await this.d.ex.place({ ref, contract: this.contract, side, qty, kind: "limit", price, tif: "ioc" });
    } catch (e) {
      this.orders.delete(ref);
      this.totals.rejects++;
      this.log(`order ${ref} not sent: ${(e as Error).message}`);
      return null;
    }
    this.totals.orders++;
    return { ref, side, qty, price };
  }

  /** Keep exactly one GTC stop covering the whole position at `stopTicks` from the average entry. Idempotent. */
  private async maintainStop(book: BookSnapshot | null) {
    if (this.stopBusy || this.hasUnsettledEntry()) return;
    this.stopBusy = true;
    try {
      const stop = this.workingStop();
      if (!this.pos.qty) {
        if (stop && !stop.cancelling) await this.cancelOrder(stop);
        return;
      }
      const side: Side = this.pos.qty > 0 ? "sell" : "buy";
      const qty = Math.abs(this.pos.qty);
      const price = this.stopPrice();
      if (stop?.cancelling) return;
      if (stop && stop.side !== side) {
        await this.cancelOrder(stop); // the replacement goes on once this cancel settles
        return;
      }
      if (stop) {
        if (stop.qty === qty && stop.price === price) return;
        await this.d.ex.modify(stop.ref, { price, qty });
        stop.qty = qty; stop.price = price;
        return;
      }
      if ([...this.orders.values()].some((o) => o.role === "stop")) return; // a filled or cancelled stop is still settling
      if (book && (side === "sell" ? price >= book.bid : price <= book.ask)) return; // already through: the stop-breached gate flattens
      const ref = this.nextRef("s");
      this.orders.set(ref, { ref, role: "stop", side, qty, price, state: "pending", reported: 0, applied: 0, sentAt: this.now().getTime(), cancelling: false });
      try {
        await this.d.ex.place({ ref, contract: this.contract, side, qty, kind: "stop", price, tif: "gtc" });
        this.totals.orders++;
      } catch (e) {
        this.orders.delete(ref);
        this.totals.rejects++;
        this.log(`stop ${ref} not sent: ${(e as Error).message}`);
      }
    } catch (e) {
      this.log(`stop maintenance failed: ${(e as Error).message}`);
    } finally {
      this.stopBusy = false;
    }
  }

  private stopPrice() {
    const dist = this.d.cfg.stopTicks(this.d.root) * this.spec.tickSize;
    return roundToTick(this.spec, this.pos.qty > 0 ? this.pos.avg - dist : this.pos.avg + dist);
  }

  /** Price is through our stop level and no stop is working to catch it (never placed, rejected, or cancelled for an exit that missed). */
  private stopBreached(book: BookSnapshot) {
    if (!this.pos.qty || this.workingStop()) return false;
    const p = this.stopPrice();
    return this.pos.qty > 0 ? book.bid <= p : book.ask >= p;
  }

  private async cancelOrder(o: Tracked) {
    o.cancelling = true;
    try { await this.d.ex.cancel(o.ref); } catch (e) { o.cancelling = false; this.log(`cancel ${o.ref} failed: ${(e as Error).message}`); }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Broker callbacks
  // ---------------------------------------------------------------------------------------------------------

  private onOrder(u: OrderUpdate) {
    const o = this.orders.get(u.ref);
    if (!o) return;
    o.state = u.state;
    o.reported = u.filled;
    if (u.state === "rejected") { this.totals.rejects++; this.log(`${o.role} ${u.ref} rejected: ${u.reason ?? "no reason given"}`); }
    this.settle(o);
  }

  private onFill(f: ExecFill) {
    const o = this.orders.get(f.ref);
    if (f.contract !== this.contract.code && !o) return;
    this.applyFill(f);
    if (o) { o.applied += f.qty; this.settle(o); }
    else this.log(`fill ${f.execId} ${f.side} ${f.qty} @ ${f.price} is not from this session's orders; applied to the position`);
    this.d.onFill?.(f, { root: this.d.root, ...this.position });
  }

  private settle(o: Tracked) {
    if (!isTerminal(o.state) || o.applied < o.reported) return;
    this.orders.delete(o.ref);
    void this.maintainStop(this.d.md.book(this.contract));
  }

  private applyFill(f: ExecFill) {
    const signed = f.side === "buy" ? f.qty : -f.qty;
    const p = this.pos;
    if (!p.qty || Math.sign(p.qty) === Math.sign(signed)) {
      p.avg = (p.avg * Math.abs(p.qty) + f.price * f.qty) / (Math.abs(p.qty) + f.qty);
      p.qty += signed;
    } else {
      const closing = Math.min(f.qty, Math.abs(p.qty));
      this.totals.realizedUsd += pnlUsd(this.spec, Math.sign(p.qty) * closing, p.avg, f.price);
      p.qty += signed;
      if (!p.qty) p.avg = 0;
      else if (Math.sign(p.qty) === Math.sign(signed)) p.avg = f.price; // flipped: the remainder opened at this price
    }
    this.totals.feesUsd += f.commission ?? this.spec.estFeesPerSide * f.qty;
    this.totals.fills++;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Bookkeeping
  // ---------------------------------------------------------------------------------------------------------

  /** Adopt the broker's position when it disagrees with ours. Skipped while anything is in flight. */
  private async reconcile(reason: string, notes: string[] = []) {
    const inFlight = [...this.orders.values()].some((o) => o.role === "entry" || (o.state !== "working" && !isTerminal(o.state)));
    if (inFlight) return;
    this.needReconcile = false;
    let positions;
    try { positions = await this.d.ex.positions(); } catch (e) { this.log(`positions failed: ${(e as Error).message}`); this.needReconcile = true; return; }
    for (const p of positions) {
      if (p.contract !== this.contract.code && p.contract.slice(0, -2) === this.d.root) {
        this.log(`WARNING: broker holds ${p.qty} ${p.contract}, which is not the contract being traded (${this.contract.code}). Close or roll it by hand.`);
      }
    }
    const broker = positions.find((p) => p.contract === this.contract.code);
    const bq = broker?.qty ?? 0;
    if (bq !== this.pos.qty || (bq && !this.pos.avg)) {
      const msg = `${reason} reconcile: broker ${bq} ${this.contract.code} @ ${broker?.avgPrice ?? "-"}, ours ${this.pos.qty}; adopting broker`;
      this.log(msg);
      notes.push(msg);
      this.pos = { qty: bq, avg: bq ? broker!.avgPrice : 0 };
    }
  }

  /** Orders with no final status after `orderTimeoutMs` get cancelled; final ones whose fills never arrived are dropped and trigger a reconcile. Working stops are exempt. */
  private expireStale(nowMs: number, notes: string[]) {
    for (const o of this.orders.values()) {
      if (nowMs - o.sentAt < this.d.cfg.orderTimeoutMs) continue;
      if (o.role === "stop" && o.state === "working") continue;
      if (isTerminal(o.state)) {
        this.orders.delete(o.ref);
        this.needReconcile = true;
        notes.push(`${o.ref}: fills never matched status; reconciling`);
      } else if (!o.cancelling) {
        notes.push(`${o.ref}: no final status after ${this.d.cfg.orderTimeoutMs} ms; cancelling`);
        void this.cancelOrder(o);
      } else {
        this.orders.delete(o.ref);
        this.needReconcile = true;
      }
    }
  }

  private async rollOver(now: Date, notes: string[]) {
    const old = this.contract;
    const next = await this.d.md.resolve(this.d.root, now);
    if (next.code === old.code) return;
    this.offContract.forEach((f) => f());
    this.offContract = [];
    this.d.md.unsubscribe(old);
    this.contract = next;
    this.mids = [];
    this.prints = [];
    await this.attach();
    notes.push(`rolled ${old.code} -> ${next.code}`);
    this.log(`rolled ${old.code} -> ${next.code}`);
  }

  private async attach() {
    await this.d.md.subscribe(this.contract, { depthRows: this.d.cfg.depthRows });
    this.offContract.push(this.d.md.onPrint(this.contract, (p) => {
      this.prints.push(p);
      const cutoff = p.ts - this.d.cfg.horizonMinutes * 60_000;
      while (this.prints.length && this.prints[0]!.ts < cutoff) this.prints.shift();
    }));
    try {
      const bars = await this.d.md.bars(this.contract, "1m", "7200 S");
      this.mids = bars.map((b) => ({ ts: b.ts + 60_000, mid: b.close }));
    } catch (e) {
      this.log(`no bar history for ${this.contract.code}: ${(e as Error).message}`);
    }
  }

  private recordMid(ts: number, mid: number) {
    this.mids.push({ ts, mid });
    while (this.mids.length && this.mids[0]!.ts < ts - HISTORY_MS) this.mids.shift();
  }

  private midAt(ts: number): number | null {
    let out: number | null = null;
    for (const m of this.mids) { if (m.ts > ts) break; out = m.mid; }
    return out;
  }

  /** New trading day: reset the PnL baseline. Then report today's PnL to the account-wide guard. */
  private markDay(now: Date, book: BookSnapshot) {
    const day = this.spec.session.tradingDay(now);
    const pnl = this.pnl(book);
    if (day !== this.day) { this.day = day; this.dayStartPnl = pnl; }
    this.totals.pnlUsd = pnl;
    this.totals.pnlTodayUsd = pnl - this.dayStartPnl;
    this.d.guard.report(this.d.root, day, this.totals.pnlTodayUsd);
  }

  /** Unrealized is marked at the price we would exit at (bid for a long, ask for a short). */
  private unrealized(book: BookSnapshot | null) {
    if (!this.pos.qty || !book) return 0;
    return pnlUsd(this.spec, this.pos.qty, this.pos.avg, this.pos.qty > 0 ? book.bid : book.ask);
  }

  private pnl(book: BookSnapshot) {
    return this.totals.realizedUsd + this.unrealized(book) - this.totals.feesUsd;
  }

  private buildState(now: Date, book: BookSnapshot, gates: Gates): FuturesTradeState {
    const spec = this.spec, cfg = this.d.cfg, t = now.getTime();
    const ret = (min: number) => {
      const then = this.midAt(t - min * 60_000);
      return then ? round(((book.mid - then) / then) * 10_000, 2) : 0;
    };
    const recent: string[] = [];
    for (let k = 30; k >= 0; k--) { const m = this.midAt(t - k * 60_000); if (m !== null) recent.push(String(round(m, 5))); }
    const horizonPrints = this.prints.filter((p) => p.ts >= t - cfg.horizonMinutes * 60_000);
    const buyQty = horizonPrints.filter((p) => p.side === "buy").reduce((s, p) => s + p.size, 0);
    const sellQty = horizonPrints.filter((p) => p.side === "sell").reduce((s, p) => s + p.size, 0);
    const vol = horizonPrints.reduce((s, p) => s + p.size, 0);
    const last = horizonPrints.at(-1);
    const lvl = (l: { price: number; size: number }) => `${l.price} x ${l.size}`;
    const levels = book.levels.bids.length ? book.levels : { bids: [{ price: book.bid, size: book.bidSize }], asks: [{ price: book.ask, size: book.askSize }] };
    const exit = this.pos.qty > 0 ? book.bid : book.ask;
    const close = spec.session.nextClose(now);
    const parts = Object.fromEntries(CHICAGO_CLOCK.formatToParts(now).map((p) => [p.type, p.value]));
    return {
      market: `${this.contract.code} ${spec.name} (${spec.exchange})`,
      root: this.d.root,
      contract: this.contract.code,
      timeChicago: `${parts.weekday} ${parts.hour}:${parts.minute}`,
      horizonMinutes: cfg.horizonMinutes,
      decisionEverySeconds: cfg.decisionSeconds,
      tick: { size: spec.tickSize, valueUsd: spec.tickValue },
      mid: book.mid,
      spreadTicks: book.spreadTicks,
      costTicks: round(book.spreadTicks + (2 * spec.estFeesPerSide) / spec.tickValue, 2),
      bookImbalance: round(book.imbalance, 3),
      book: { bids: levels.bids.slice(0, 5).map(lvl), asks: levels.asks.slice(0, 5).map(lvl) },
      returnsBps: { m1: ret(1), m5: ret(5), m15: ret(15), m60: ret(60) },
      recentMids: recent.join(" "),
      trades: {
        count: horizonPrints.length, buyQty, sellQty, cvd: buyQty - sellQty,
        vwap: vol ? round(horizonPrints.reduce((s, p) => s + p.price * p.size, 0) / vol, 5) : null,
        lastPrice: last?.price ?? null, lastSide: last?.side ?? null,
      },
      position: {
        side: this.pos.qty > 0 ? "long" : this.pos.qty < 0 ? "short" : "flat",
        contracts: Math.abs(this.pos.qty),
        entry: this.pos.qty ? this.pos.avg : null,
        unrealizedTicks: this.pos.qty ? round(((exit - this.pos.avg) / spec.tickSize) * Math.sign(this.pos.qty), 1) : 0,
      },
      session: { minutesToClose: close?.minutes ?? null, closeIsWeekend: close?.weekend ?? false },
      allowed: {
        buy: clampTarget(this.pos.qty + cfg.qty, this.pos.qty, gates).target > this.pos.qty,
        sell: clampTarget(this.pos.qty - cfg.qty, this.pos.qty, gates).target < this.pos.qty,
      },
    };
  }

  private emit(p: {
    book: BookSnapshot | null; notes: string[]; late?: boolean;
    decision?: FuturesEvent["decision"]; wanted?: number | null; target?: number | null; gate?: Gate | null; gateDetail?: string; order?: FuturesEvent["order"];
  }) {
    const b = p.book;
    const stop = this.workingStop();
    const e: FuturesEvent = {
      root: this.d.root, contract: this.contract.code, ts: this.now().getTime(), cycle: this.cycleNo,
      bid: b?.bid ?? null, ask: b?.ask ?? null, mid: b?.mid ?? null, spreadTicks: b?.spreadTicks ?? null, delayed: b?.delayed ?? false,
      decision: p.late ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, latencyMs: 0, late: true } : p.decision ?? null,
      wanted: p.wanted ?? null, target: p.target ?? null, gate: p.gate ?? null,
      ...(p.gateDetail ? { gateDetail: p.gateDetail } : {}),
      order: p.order ?? null,
      position: { qty: this.pos.qty, avgPrice: this.pos.qty ? this.pos.avg : null, unrealizedUsd: round(this.unrealized(b), 2) },
      stop: stop ? { price: stop.price, qty: stop.qty, state: stop.state } : null,
      totals: { ...this.totals, realizedUsd: round(this.totals.realizedUsd, 2), feesUsd: round(this.totals.feesUsd, 2), jevUsd: round(this.totals.jevUsd, 6), pnlUsd: round(this.totals.pnlUsd, 2), pnlTodayUsd: round(this.totals.pnlTodayUsd, 2) },
      halted: this.d.guard.halted,
      notes: p.notes,
    };
    this.history.push(e);
    if (this.history.length > this.d.cfg.historySize) this.history.shift();
    this.d.onEvent?.(e);
  }

  private workingStop() {
    for (const o of this.orders.values()) if (o.role === "stop" && !isTerminal(o.state)) return o;
    return null;
  }

  private hasUnsettledEntry() {
    for (const o of this.orders.values()) if (o.role === "entry") return true;
    return false;
  }

  private nextRef(kind: "e" | "s") {
    return `${this.d.root}-${kind}${++this.refSeq}-${Date.now().toString(36)}`;
  }

  private log(msg: string) {
    (this.d.log ?? console.log)(`[${this.d.root}] ${msg}`);
  }
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
