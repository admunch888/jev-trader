import { config } from "../config";
import type { Action, Model } from "../model";
import type { FuturesConfig } from "./config";
import { pnlUsd, roundToTick, SPECS } from "./contracts";
import type { FuturesTradeState, FuturesTradeStateV2, Move } from "./model";
import { chaseFilter, clampTarget, RiskGuard, shapeTarget, smoothed, targetFromProbability, type Gate, type Gates, type Shape } from "./policy";
import type { BookSnapshot, ContractSpec, ExecFill, Execution, FuturesContract, MarketData, OrderState, OrderUpdate, Print, Root, Side } from "./types";

export interface FuturesEvent {
  root: Root;
  /** The model that made this cycle's decision ("mock", a Jev id, "replay"). */
  model: string;
  contract: string;
  ts: number;
  cycle: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadTicks: number | null;
  delayed: boolean;
  /**
   * Null when the model was not asked (a gate already decided, no quote) or did not answer in time. `upUsed` is the
   * averaged up-probability the policy acted on (null until `smoothN` readings exist).
   */
  decision: { action: Action; probabilities: Record<Action, number>; latencyMs: number; late: boolean; upUsed?: number | null } | null;
  /** Position the model's (averaged) answer asked for, before the no-flip, min-hold and risk rules. */
  wanted: number | null;
  /** Position after those rules; an order is sent when it differs from the current one. */
  target: number | null;
  /** What changed the target: a risk gate, or a policy rule (confirm, no-flip, min-hold). */
  gate: Gate | Shape | null;
  gateDetail?: string;
  order: { ref: string; side: Side; qty: number; price: number } | null;
  position: { qty: number; avgPrice: number | null; unrealizedUsd: number };
  stop: { price: number; qty: number; state: OrderState } | null;
  takeProfit: { price: number; qty: number; state: OrderState } | null;
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

/** One model call: exactly what it was given and what it answered. Written to data/futures-decisions.jsonl live, and replayable by the backtester. */
export interface DecisionRecord {
  ts: number;
  root: Root;
  contract: string;
  model: string;
  state: FuturesTradeState;
  probabilities: Record<Action, number>;
  action: Action;
  latencyMs: number;
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
  onDecision?: (r: DecisionRecord) => void;
  log?: (msg: string) => void;
}

interface Tracked {
  ref: string;
  role: "entry" | "stop" | "tp";
  /** An entry resting at our own touch (FUT_ENTRY=passive), cancelled if still unfilled after `passiveCycles` cycles. */
  passive: boolean;
  placedCycle: number;
  side: Side;
  qty: number;
  price: number;
  state: OrderState;
  /** Filled quantity per the broker's order status. */
  reported: number;
  /** Filled quantity we have applied from fills. The order is settled once it is final and these agree. */
  applied: number;
  sentAt: number;
  /** Cancelled (entries) or dropped and reconciled (anything) if it has no final status by then. */
  deadline: number;
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
 *   6. keep one protective GTC stop for the whole position, `stopTicks` from the average entry, trailing the best
 *      price once `trailStartTicks` in profit, plus an optional take-profit limit in the same one-cancels-all group
 *
 * Between 4 and 5 the chase filter can hold back a new position the market has already run in. With
 * FUT_ENTRY=passive new positions rest at our own touch for a few cycles instead of crossing the spread.
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
  /** When the current position was opened (or reversed); drives the minimum hold. */
  private openedAt: number | null = null;
  /** Best exit price seen since the position opened (bid for a long, ask for a short); drives the trailing stop. Null = the entry price. */
  private best: number | null = null;
  /** One-cancels-all group for the current position's stop and take-profit. */
  private oca = "";
  private ocaSeq = 0;
  /** The model's recent up-probabilities from consecutive cycles, for `smoothN`. */
  private readings: number[] = [];
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

  /** Record the position marked at the current book without deciding anything (the end of a backtest). */
  mark(note: string) {
    const book = this.d.md.book(this.contract);
    if (book) this.markDay(this.now(), book);
    this.emit({ book, notes: [note] });
  }

  /** Send an order to go flat now (shutdown), after pulling a resting passive entry. Stops stay working until the fill lands. */
  async flatten() {
    const resting = this.passiveEntry();
    if (resting && !resting.cancelling) await this.cancelOrder(resting);
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
    if (!book) {
      const why = this.d.md.health?.(this.contract).reason;
      return this.emit({ book: null, notes: [...notes, why ? `no quote: ${why}` : "no quote"] });
    }
    this.recordMid(now.getTime(), book.mid);
    this.markDay(now, book);

    if (this.needReconcile || this.cycleNo % this.d.cfg.reconcileEveryCycles === 0) await this.reconcile("periodic", notes);

    const gates = this.gates(now, book);
    const forced = gates.brokerDown || gates.halted || gates.roll || gates.weekend || gates.stopBreached || gates.closed;
    const cfg = this.d.cfg;
    let decision: FuturesEvent["decision"] = null;
    let wanted: number | null = null;
    let shaped = this.pos.qty;
    let shape: Shape | null = null;
    if (!forced) {
      const state = this.buildState(now, book, gates);
      const d = await this.decide(state);
      if (d) {
        this.d.onDecision?.({ ts: now.getTime(), root: this.d.root, contract: this.contract.code, model: this.d.model.name, state, probabilities: d.probabilities, action: d.action, latencyMs: Math.round(d.latencyMs) });
        this.readings.push(d.probabilities.buy);
        if (this.readings.length > Math.max(1, cfg.smoothN)) this.readings.shift();
        const up = smoothed(this.readings, Math.max(1, cfg.smoothN));
        decision = { action: d.action, probabilities: d.probabilities, latencyMs: Math.round(d.latencyMs), late: false, upUsed: up === null ? null : round(up, 4) };
        if (up === null) shape = "confirm"; // not enough consecutive readings yet: hold
        else {
          wanted = targetFromProbability(up, this.pos.qty, cfg);
          const heldMs = this.openedAt === null ? null : now.getTime() - this.openedAt;
          ({ target: shaped, shape } = shapeTarget(wanted, this.pos.qty, { allowFlip: cfg.allowFlip, heldMs, minHoldMs: cfg.minHoldMinutes * 60_000 }));
          if (cfg.chaseSigma && shaped !== this.pos.qty) {
            const m = this.moveSigma(now.getTime(), book.mid, cfg.chaseMinutes);
            const c = chaseFilter(shaped, this.pos.qty, m, cfg.chaseSigma);
            if (c.chased) {
              shaped = c.target; shape = "chase";
              notes.push(`already moved ${m} typical ${cfg.chaseMinutes} min moves that way; not chasing`);
            }
          }
        }
      } else {
        this.readings = [];
        notes.push("model gave no answer in time; holding");
      }
    } else this.readings = []; // readings must be consecutive
    const clamped = clampTarget(shaped, this.pos.qty, gates);
    const { target, detail } = clamped;
    const gate = clamped.gate ?? shape;

    let order: FuturesEvent["order"] = null;
    const resting = this.passiveEntry();
    if (resting) {
      const wantSide = target > this.pos.qty ? "buy" : target < this.pos.qty ? "sell" : null;
      const expired = this.cycleNo - resting.placedCycle >= cfg.passiveCycles;
      if (resting.cancelling || gates.brokerDown) notes.push(`passive ${resting.side} at ${resting.price} settling`);
      else if (wantSide !== resting.side || expired) {
        notes.push(`passive ${resting.side} at ${resting.price} ${expired ? `unfilled after ${cfg.passiveCycles} cycles` : "no longer wanted"}; cancelling`);
        await this.cancelOrder(resting);
      } else notes.push(`passive ${resting.side} resting at ${resting.price}`);
    } else if (target !== this.pos.qty) {
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
    const exec = this.d.ex.status;
    return {
      brokerDown: !!exec && exec !== "connected",
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

  /**
   * One IOC limit at the touch (plus `slipTicks`) for the whole difference, or with FUT_ENTRY=passive, a new
   * position rests at our own touch (a buy at the bid) instead. Reducing orders first pull the stop and
   * take-profit so they cannot fill as well.
   */
  private async sendTowards(target: number, book: BookSnapshot): Promise<FuturesEvent["order"]> {
    const cfg = this.d.cfg;
    const delta = target - this.pos.qty;
    const side: Side = delta > 0 ? "buy" : "sell";
    const qty = Math.abs(delta);
    const reduces = this.pos.qty !== 0 && Math.sign(delta) !== Math.sign(this.pos.qty);
    const passive = cfg.entryMode === "passive" && !reduces;
    const slip = cfg.slipTicks * this.spec.tickSize;
    const price = passive ? (side === "buy" ? book.bid : book.ask) : roundToTick(this.spec, side === "buy" ? book.ask + slip : book.bid - slip);
    if (reduces) {
      for (const role of ["stop", "tp"] as const) { const o = this.workingExit(role); if (o) await this.cancelOrder(o); }
    }
    const ref = this.nextRef("e");
    const sentAt = this.now().getTime();
    const rest = passive ? cfg.passiveCycles * cfg.decisionSeconds * 1000 : 0;
    this.orders.set(ref, { ref, role: "entry", passive, placedCycle: this.cycleNo, side, qty, price, state: "pending", reported: 0, applied: 0, sentAt, deadline: sentAt + rest + cfg.orderTimeoutMs, cancelling: false });
    try {
      await this.d.ex.place({ ref, contract: this.contract, side, qty, kind: "limit", price, tif: passive ? "day" : "ioc" });
    } catch (e) {
      this.orders.delete(ref);
      this.totals.rejects++;
      this.log(`order ${ref} not sent: ${(e as Error).message}`);
      return null;
    }
    this.totals.orders++;
    return { ref, side, qty, price };
  }

  /**
   * Keep exactly one GTC stop covering the whole position (at `stopPrice`, which trails once in profit) and, if
   * enabled, one take-profit limit, both in the position's one-cancels-all group. Idempotent.
   */
  private async maintainStop(book: BookSnapshot | null) {
    if (this.stopBusy || this.entryInFlux()) return;
    if (this.d.ex.status && this.d.ex.status !== "connected") return; // the orders already at IBKR keep working
    this.stopBusy = true;
    try {
      await this.keepExit("stop", this.stopPrice(), book);
      await this.keepExit("tp", this.takeProfitPrice(), book);
    } catch (e) {
      this.log(`stop maintenance failed: ${(e as Error).message}`);
    } finally {
      this.stopBusy = false;
    }
  }

  private async keepExit(role: "stop" | "tp", price: number | null, book: BookSnapshot | null) {
    const o = this.workingExit(role);
    if (!this.pos.qty || price === null) {
      if (o && !o.cancelling) await this.cancelOrder(o);
      return;
    }
    const side: Side = this.pos.qty > 0 ? "sell" : "buy";
    const qty = Math.abs(this.pos.qty);
    // A stop already at or through the touch would trigger at once: leave it (or the old one) and let the stop-breached gate exit.
    const through = role === "stop" && !!book && (side === "sell" ? price >= book.bid : price <= book.ask);
    if (o?.cancelling) return;
    if (o && o.side !== side) {
      await this.cancelOrder(o); // the replacement goes on once this cancel settles
      return;
    }
    if (o) {
      if ((o.qty === qty && o.price === price) || through) return;
      await this.d.ex.modify(o.ref, { price, qty });
      o.qty = qty; o.price = price;
      return;
    }
    if ([...this.orders.values()].some((x) => x.role === role)) return; // a filled or cancelled one is still settling
    if (through) return;
    const ref = this.nextRef(role === "stop" ? "s" : "t");
    const sentAt = this.now().getTime();
    this.orders.set(ref, { ref, role, passive: false, placedCycle: this.cycleNo, side, qty, price, state: "pending", reported: 0, applied: 0, sentAt, deadline: sentAt + this.d.cfg.orderTimeoutMs, cancelling: false });
    try {
      await this.d.ex.place({ ref, contract: this.contract, side, qty, kind: role === "stop" ? "stop" : "limit", price, tif: "gtc", oca: this.oca });
      this.totals.orders++;
    } catch (e) {
      this.orders.delete(ref);
      this.totals.rejects++;
      this.log(`${role === "stop" ? "stop" : "take-profit"} ${ref} not sent: ${(e as Error).message}`);
    }
  }

  /** `stopTicks` from the average entry; once the best price since entry is `trailStartTicks` in profit, `trailTicks` behind that best, whichever is tighter. */
  private stopPrice() {
    const cfg = this.d.cfg, root = this.d.root, tick = this.spec.tickSize, dir = Math.sign(this.pos.qty);
    const base = this.pos.avg - dir * cfg.stopTicks(root) * tick;
    const start = cfg.trailStartTicks(root), trail = cfg.trailTicks(root);
    if (start > 0 && trail > 0 && this.best !== null && ((this.best - this.pos.avg) * dir) / tick >= start - 1e-9) {
      const trailed = this.best - dir * trail * tick;
      return roundToTick(this.spec, dir > 0 ? Math.max(base, trailed) : Math.min(base, trailed));
    }
    return roundToTick(this.spec, base);
  }

  private takeProfitPrice() {
    const tp = this.d.cfg.takeProfitTicks(this.d.root);
    return tp > 0 ? roundToTick(this.spec, this.pos.avg + Math.sign(this.pos.qty) * tp * this.spec.tickSize) : null;
  }

  /** Price is at or through our stop level and no stop is working there to catch it (never placed, rejected, cancelled for an exit that missed, or a trail the market jumped past). */
  private stopBreached(book: BookSnapshot) {
    if (!this.pos.qty) return false;
    const p = this.stopPrice();
    if (!(this.pos.qty > 0 ? book.bid <= p : book.ask >= p)) return false;
    return this.workingExit("stop")?.price !== p;
  }

  /** Every quote: track the best exit price for the trailing stop, and move the stop as soon as the trail moves. */
  private onBookTick(b: BookSnapshot) {
    if (!this.pos.qty) return;
    const exit = this.pos.qty > 0 ? b.bid : b.ask;
    const best = this.best ?? this.pos.avg;
    if ((exit - best) * Math.sign(this.pos.qty) <= 0) return;
    this.best = exit;
    const stop = this.workingExit("stop");
    if (stop && !stop.cancelling && stop.price !== this.stopPrice()) void this.maintainStop(b);
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
    const before = p.qty;
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
    this.markOpened(before, p.qty);
  }

  /** A position that starts from flat, or reverses, starts its minimum hold, trail and one-cancels-all group now; going flat clears them. */
  private markOpened(before: number, after: number) {
    if (!after) { this.openedAt = null; this.best = null; }
    else if (!before || Math.sign(before) !== Math.sign(after)) {
      this.openedAt = this.now().getTime();
      this.best = null;
      this.oca = `${this.d.root}-oca${++this.ocaSeq}-${Date.now().toString(36)}`;
    }
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
      this.markOpened(this.pos.qty, bq);
      this.pos = { qty: bq, avg: bq ? broker!.avgPrice : 0 };
    }
  }

  /** Orders with no final status by their deadline get cancelled; final ones whose fills never arrived are dropped and trigger a reconcile. Working stops and take-profits are exempt. */
  private expireStale(nowMs: number, notes: string[]) {
    for (const o of this.orders.values()) {
      if (nowMs < o.deadline) continue;
      if (o.role !== "entry" && o.state === "working") continue;
      if (isTerminal(o.state)) {
        this.orders.delete(o.ref);
        this.needReconcile = true;
        notes.push(`${o.ref}: fills never matched status; reconciling`);
      } else if (!o.cancelling) {
        notes.push(`${o.ref}: no final status after ${nowMs - o.sentAt} ms; cancelling`);
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
    this.readings = [];
    await this.attach();
    notes.push(`rolled ${old.code} -> ${next.code}`);
    this.log(`rolled ${old.code} -> ${next.code}`);
  }

  private async attach() {
    await this.d.md.subscribe(this.contract, { depthRows: this.d.cfg.depthRows });
    this.offContract.push(this.d.md.onBook(this.contract, (b) => this.onBookTick(b)));
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

  /**
   * One mid per minute the market was open over the last `n` minutes, oldest first, ending with `mid` now. Minutes
   * in the daily break (or a weekend) are skipped: counting them as flat would shrink the typical move and make
   * every move after the open look like a burst.
   */
  private openMinutes(t: number, mid: number, n: number) {
    const out: number[] = [];
    for (let k = n; k >= 1; k--) {
      const ts = t - k * 60_000;
      if (!this.spec.session.isOpen(new Date(ts))) continue;
      const m = this.midAt(ts);
      if (m !== null) out.push(m);
    }
    out.push(mid);
    return out;
  }

  /** Standard deviation of the 1 minute move over the last 2 hours, in ticks; null with under 20 minutes of history. */
  private typical1m(t: number, mid: number) {
    const xs = this.openMinutes(t, mid, 120);
    const steps = xs.slice(1).map((m, i) => (m - xs[i]!) / this.spec.tickSize);
    return steps.length >= 20 ? Math.sqrt(steps.reduce((a, x) => a + x * x, 0) / steps.length) : null;
  }

  /** The move over the last `w` minutes in units of the typical `w` minute move, or null without enough history. */
  private moveSigma(t: number, mid: number, w: number) {
    const sd1 = this.typical1m(t, mid);
    const then = this.midAt(t - w * 60_000);
    return sd1 && then !== null ? round((mid - then) / this.spec.tickSize / (sd1 * Math.sqrt(w)), 2) : null;
  }

  private buildState(now: Date, book: BookSnapshot, gates: Gates): FuturesTradeState {
    if (this.d.cfg.stateVersion === "v2") return this.buildStateV2(now, book, gates);
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

  /** v2 input: moves in units of normal, range and average context, no book sizes. See `FuturesTradeStateV2`. */
  private buildStateV2(now: Date, book: BookSnapshot, gates: Gates): FuturesTradeStateV2 {
    const spec = this.spec, cfg = this.d.cfg, t = now.getTime();
    const ticks = (px: number) => px / spec.tickSize;
    const minutes = (n: number) => this.openMinutes(t, book.mid, n);
    const sd1 = this.typical1m(t, book.mid);
    const typical = (w: number) => (sd1 ? round(sd1 * Math.sqrt(w), 2) : null);
    const move = (w: number): Move => {
      const then = this.midAt(t - w * 60_000);
      const tk = then === null ? 0 : round(ticks(book.mid - then), 1);
      const typ = typical(w);
      return { ticks: tk, sigma: typ && then !== null ? round(tk / typ, 2) : null };
    };
    const range = (w: number) => {
      const xs = minutes(w);
      const hi = Math.max(...xs), lo = Math.min(...xs);
      return { position: xs.length >= 5 && hi > lo ? round((book.mid - lo) / (hi - lo), 2) : null, widthTicks: round(ticks(hi - lo), 1) };
    };
    const hour = minutes(60);
    const avgTicks = round(ticks(book.mid - hour.reduce((a, b) => a + b, 0) / hour.length), 1);
    const typ15 = typical(15);
    const recent = minutes(30).map((m) => String(round(m, 5)));
    const horizonPrints = this.prints.filter((p) => p.ts >= t - cfg.horizonMinutes * 60_000);
    const vol = horizonPrints.reduce((a, p) => a + p.size, 0);
    const net = horizonPrints.reduce((a, p) => a + (p.side === "buy" ? p.size : p.side === "sell" ? -p.size : 0), 0);
    const exit = this.pos.qty > 0 ? book.bid : book.ask;
    const close = spec.session.nextClose(now);
    const parts = Object.fromEntries(CHICAGO_CLOCK.formatToParts(now).map((p) => [p.type, p.value]));
    const hm = Number(parts.hour) * 60 + Number(parts.minute);
    return {
      version: 2,
      market: `${this.contract.code} ${spec.name} (${spec.exchange})`,
      root: this.d.root,
      contract: this.contract.code,
      timeChicago: `${parts.weekday} ${parts.hour}:${parts.minute}`,
      cashSession: !["Sat", "Sun"].includes(parts.weekday!) && hm >= 8 * 60 + 30 && hm < 15 * 60,
      horizonMinutes: cfg.horizonMinutes,
      decisionEverySeconds: cfg.decisionSeconds,
      tick: { size: spec.tickSize, valueUsd: spec.tickValue },
      mid: book.mid,
      spreadTicks: book.spreadTicks,
      costTicks: round(book.spreadTicks + (2 * spec.estFeesPerSide) / spec.tickValue, 2),
      typicalMoveTicks: { m1: typical(1), m5: typical(5), m15: typ15 },
      moves: { m1: move(1), m5: move(5), m15: move(15), m60: move(60) },
      range: { m30: range(30), m60: range(60) },
      vsAverage60: { ticks: avgTicks, sigma: typ15 ? round(avgTicks / typ15, 2) : null },
      recentMids: recent.join(" "),
      flow: { share: vol ? round(net / vol, 2) : null, contracts: vol },
      position: {
        side: this.pos.qty > 0 ? "long" : this.pos.qty < 0 ? "short" : "flat",
        contracts: Math.abs(this.pos.qty),
        entry: this.pos.qty ? this.pos.avg : null,
        unrealizedTicks: this.pos.qty ? round(((exit - this.pos.avg) / spec.tickSize) * Math.sign(this.pos.qty), 1) : 0,
        heldMinutes: this.openedAt === null ? null : round((t - this.openedAt) / 60_000, 1),
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
    decision?: FuturesEvent["decision"]; wanted?: number | null; target?: number | null; gate?: Gate | Shape | null; gateDetail?: string; order?: FuturesEvent["order"];
  }) {
    const b = p.book;
    const stop = this.workingExit("stop");
    const tp = this.workingExit("tp");
    const e: FuturesEvent = {
      root: this.d.root, model: this.d.model.name, contract: this.contract.code, ts: this.now().getTime(), cycle: this.cycleNo,
      bid: b?.bid ?? null, ask: b?.ask ?? null, mid: b?.mid ?? null, spreadTicks: b?.spreadTicks ?? null, delayed: b?.delayed ?? false,
      decision: p.late ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, latencyMs: 0, late: true } : p.decision ?? null,
      wanted: p.wanted ?? null, target: p.target ?? null, gate: p.gate ?? null,
      ...(p.gateDetail ? { gateDetail: p.gateDetail } : {}),
      order: p.order ?? null,
      position: { qty: this.pos.qty, avgPrice: this.pos.qty ? this.pos.avg : null, unrealizedUsd: round(this.unrealized(b), 2) },
      stop: stop ? { price: stop.price, qty: stop.qty, state: stop.state } : null,
      takeProfit: tp ? { price: tp.price, qty: tp.qty, state: tp.state } : null,
      totals: { ...this.totals, realizedUsd: round(this.totals.realizedUsd, 2), feesUsd: round(this.totals.feesUsd, 2), jevUsd: round(this.totals.jevUsd, 6), pnlUsd: round(this.totals.pnlUsd, 2), pnlTodayUsd: round(this.totals.pnlTodayUsd, 2) },
      halted: this.d.guard.halted,
      notes: p.notes,
    };
    this.history.push(e);
    if (this.history.length > this.d.cfg.historySize) this.history.shift();
    this.d.onEvent?.(e);
  }

  private workingExit(role: "stop" | "tp") {
    for (const o of this.orders.values()) if (o.role === role && !isTerminal(o.state)) return o;
    return null;
  }

  private hasUnsettledEntry() {
    for (const o of this.orders.values()) if (o.role === "entry") return true;
    return false;
  }

  private passiveEntry() {
    for (const o of this.orders.values()) if (o.role === "entry" && o.passive) return o;
    return null;
  }

  /** An entry whose fills can still change the position at any moment, other than a passive one resting on the book (the stop follows its fills). */
  private entryInFlux() {
    for (const o of this.orders.values()) if (o.role === "entry" && !(o.passive && (o.state === "working" || o.state === "partial"))) return true;
    return false;
  }

  private nextRef(kind: "e" | "s" | "t") {
    return `${this.d.root}-${kind}${++this.refSeq}-${Date.now().toString(36)}`;
  }

  private log(msg: string) {
    (this.d.log ?? console.log)(`[${this.d.root}] ${msg}`);
  }
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
