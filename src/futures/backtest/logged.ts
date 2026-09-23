import type { Decision, Model } from "../../model";
import type { FuturesTradeState } from "../model";
import type { Root } from "../types";
import { readLines } from "./format";

export interface LoggedDecision { ts: number; root: Root; up: number; latencyMs: number }

/**
 * Past model answers from the live bot's logs: `data/futures-decisions.jsonl` (every call, with its input) and
 * `data/futures-events.jsonl` (every cycle; older runs only have this one). Late and missing answers are skipped,
 * as are answers recorded from the mock or from a replay; the same decision found in both files counts once.
 * Events written before the model name was logged cannot be told apart: trim those files by time if needed.
 */
export async function loadDecisions(paths: string[]): Promise<LoggedDecision[]> {
  const seen = new Map<string, LoggedDecision>();
  for (const path of paths) {
    for await (const line of readLines(path)) {
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      const probs = r.probabilities ?? (r.decision && !r.decision.late ? r.decision.probabilities : null);
      if (!probs || typeof probs.buy !== "number" || !r.root || !r.ts) continue;
      if (r.model === "mock" || r.model === "replay") continue;
      const d: LoggedDecision = { ts: r.ts, root: r.root, up: probs.buy, latencyMs: r.latencyMs ?? r.decision?.latencyMs ?? 0 };
      seen.set(`${d.root}@${d.ts}`, d);
    }
  }
  return [...seen.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * A `Model` that answers with what the real model said at the time, so policy settings (thresholds, averaging,
 * minimum hold, flips) can be backtested on the ticks recorded alongside, at no API cost.
 *
 * At replay time T it returns the latest logged answer for that root made at or before T (never after: no
 * lookahead), provided it is at most `maxAgeMs` old; otherwise it has no answer and the trader holds, exactly as
 * it would on a model timeout. Backtest cycles need not line up with the logged ones; with the same interval the
 * answer used is at most one interval old, which slightly delays entries compared with live.
 */
export class LoggedModel implements Model<FuturesTradeState> {
  readonly name = "replay";
  hits = 0;
  misses = 0;
  private byRoot = new Map<Root, LoggedDecision[]>();

  constructor(decisions: LoggedDecision[], private now: () => number, private maxAgeMs = 60_000) {
    for (const d of decisions) this.byRoot.set(d.root, [...(this.byRoot.get(d.root) ?? []), d]);
  }

  get count() { let n = 0; for (const v of this.byRoot.values()) n += v.length; return n; }

  /** First and last logged answer, to pick the backtest window. */
  get span(): { from: number; to: number } | null {
    const all = [...this.byRoot.values()].flat();
    if (!all.length) return null;
    return { from: Math.min(...all.map((d) => d.ts)), to: Math.max(...all.map((d) => d.ts)) };
  }

  async decide(s: FuturesTradeState): Promise<Decision> {
    const list = this.byRoot.get(s.root) ?? [];
    const t = this.now();
    let lo = 0, hi = list.length - 1, at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid]!.ts <= t) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    const d = at >= 0 ? list[at]! : null;
    if (!d || t - d.ts > this.maxAgeMs) { this.misses++; throw new Error(NO_LOGGED); }
    this.hits++;
    return { action: d.up >= 0.5 ? "buy" : "sell", probabilities: { buy: d.up, sell: 1 - d.up, hold: 0 }, upIn10: d.up, latencyMs: d.latencyMs, inputTokens: 0 };
  }
}

export const NO_LOGGED = "no logged decision for this time";
