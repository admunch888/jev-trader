/**
 * Decision policy and risk limits, kept pure so they can be tested without a broker.
 *
 * The model answers buy or sell with a probability. `targetFromProbability` turns that into a target position
 * in contracts: long or short past `enter`, flat inside `flatBand` of 50/50, otherwise keep what we have (so a
 * wavering model does not churn). `clampTarget` then applies the risk gates, which can only move the target
 * toward flat, never away from it.
 */

export interface PolicyParams { enterProb: number; flatBand: number; qty: number }

export function targetFromProbability(pUp: number, current: number, p: PolicyParams): number {
  if (pUp >= p.enterProb) return p.qty;
  if (pUp <= 1 - p.enterProb) return -p.qty;
  if (Math.abs(pUp - 0.5) <= p.flatBand) return 0;
  return current;
}

/** Why the target was changed from what the model asked for. Order of precedence is the order checked. */
export type Gate =
  | "broker" // order connection down: nothing can be sent, hold
  | "halted" // daily loss limit, flatten
  | "roll" // contract past its roll date, flatten
  | "weekend" // close to the weekend close, flatten
  | "stop-breached" // price is through where the stop would sit, flatten
  | "closed" // session closed, do nothing
  | "no-new-risk" // entry cutoff, wide spread or delayed data: exits only
  | "max-contracts";

export interface Gates {
  brokerDown: boolean;
  halted: boolean;
  roll: boolean;
  weekend: boolean;
  stopBreached: boolean;
  closed: boolean;
  /** Reasons new risk is blocked right now; empty means allowed. */
  noNewRisk: string[];
  maxContracts: number;
}

export function clampTarget(target: number, current: number, g: Gates): { target: number; gate: Gate | null; detail?: string } {
  if (g.brokerDown) return { target: current, gate: "broker" };
  if (g.halted) return { target: 0, gate: "halted" };
  if (g.roll) return { target: 0, gate: "roll" };
  if (g.weekend) return { target: 0, gate: "weekend" };
  if (g.stopBreached) return { target: 0, gate: "stop-breached" };
  if (g.closed) return { target: current, gate: "closed" };
  if (g.noNewRisk.length && addsRisk(target, current)) {
    return { target: reduceOnly(target, current), gate: "no-new-risk", detail: g.noNewRisk.join(", ") };
  }
  if (Math.abs(target) > g.maxContracts) return { target: Math.sign(target) * g.maxContracts, gate: "max-contracts" };
  return { target, gate: null };
}

/** True when moving from `current` to `target` increases exposure or opens the other side. */
export const addsRisk = (target: number, current: number) =>
  target !== 0 && (Math.sign(target) !== Math.sign(current) || Math.abs(target) > Math.abs(current));

/** The part of a move that only reduces: flips and adds become flat or unchanged. */
export function reduceOnly(target: number, current: number) {
  if (target === 0 || Math.sign(target) !== Math.sign(current)) return 0;
  return Math.sign(target) * Math.min(Math.abs(target), Math.abs(current));
}

/**
 * Account-wide daily loss limit across all roots. Each trader reports its PnL for the current trading day; once
 * the sum reaches -limit every trader flattens and stays flat until the trading day changes.
 */
export class RiskGuard {
  private pnl = new Map<string, number>();
  private day: string | null = null;
  private haltedReason: string | null = null;

  constructor(private readonly dailyLossUsd: number) {}

  report(root: string, tradingDay: string, pnlTodayUsd: number) {
    if (tradingDay !== this.day) {
      this.day = tradingDay;
      this.pnl.clear();
      this.haltedReason = null;
    }
    this.pnl.set(root, pnlTodayUsd);
    const total = this.totalToday;
    if (!this.haltedReason && total <= -this.dailyLossUsd) {
      this.haltedReason = `daily loss $${(-total).toFixed(2)} reached the $${this.dailyLossUsd} limit on ${tradingDay}`;
    }
  }

  get totalToday() { let t = 0; for (const v of this.pnl.values()) t += v; return t; }
  get halted() { return this.haltedReason; }
}
