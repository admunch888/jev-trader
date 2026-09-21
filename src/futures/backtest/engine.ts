import type { Model } from "../../model";
import type { FuturesConfig } from "../config";
import { SPECS } from "../contracts";
import type { FuturesTradeState } from "../model";
import { RiskGuard } from "../policy";
import { SimExecution } from "../sim";
import { FuturesTrader, type FuturesEvent } from "../trader";
import type { ExecFill, Root } from "../types";
import { indexTicks, type DayFile } from "./format";
import { contractPicker, mergeStreams, ReplayMarketData } from "./replay";

export interface BacktestOptions {
  /** Tick store root, e.g. data/ticks. */
  dataDir: string;
  roots: Root[];
  /** Trading days, inclusive, YYYY-MM-DD. Omit for everything recorded. */
  from?: string;
  to?: string;
  cfg: FuturesConfig;
  model?: Model<FuturesTradeState>;
  /** Alternative to `model` for models that need the replay clock (e.g. `LoggedModel`). */
  modelFactory?: (clock: () => number) => Model<FuturesTradeState>;
  /** Decision to exchange: model call + network + exchange. Orders and cancels are matched against the book this long after they are sent. */
  latencyMs: number;
  /** Cap marketable fills at the size shown at the touch. */
  respectSize: boolean;
  /** Replay this long before the first decision so returns and bars have history. */
  warmupMinutes: number;
  /** Skip a cycle when the contract's last quote is older than this (data gaps, halts, missing files). */
  staleMs: number;
  onDay?: (day: string, stats: { cycles: number; records: number }) => void;
  log?: (msg: string) => void;
}

export interface BacktestFill { root: Root; fill: ExecFill; position: number }

export interface BacktestResult {
  options: Omit<BacktestOptions, "model" | "modelFactory" | "onDay" | "log" | "cfg"> & { model: string; cfg: Record<string, unknown> };
  files: DayFile[];
  records: number;
  /** Every cycle event from every root, in time order. */
  events: FuturesEvent[];
  fills: BacktestFill[];
  /** Cycles skipped because the data for that contract was stale. */
  skipped: Record<string, number>;
  /** First and last mid per root after warmup, for the buy and hold comparison. */
  marks: Record<string, { first: number; last: number; firstTs: number; lastTs: number }>;
  startTs: number;
  endTs: number;
  wallMs: number;
}

/**
 * Replays recorded ticks through the same `FuturesTrader` the live bot runs, against `SimExecution` as the
 * exchange, on a virtual clock:
 *
 *   for each record in time order
 *     run everything due before it: decision cycles (every `decisionSeconds` per root, staggered like live)
 *       and orders or cancels reaching the exchange after `latencyMs`, in time order
 *     apply the record to the book (resting stops can trigger here)
 *
 * Status and fill messages are delivered as microtasks and flushed before the clock moves on, so the loop sees
 * them in the same order it would live. The model is called for real (mock is instant; Jev costs a call per cycle).
 */
export async function runBacktest(o: BacktestOptions): Promise<BacktestResult> {
  const t0 = performance.now();
  const log = o.log ?? (() => {});
  const files = indexTicks(o.dataDir, o.roots, o.from, o.to);
  if (!files.length) throw new Error(`no recorded ticks for ${o.roots.join(",")} in ${o.dataDir}${o.from || o.to ? ` between ${o.from ?? "start"} and ${o.to ?? "end"}` : ""}`);

  const pick = await contractPicker(files, (root, at) => SPECS[root].session.tradingDay(at))();
  const md = new ReplayMarketData(pick);
  let clock = 0;
  const model = o.modelFactory?.(() => clock) ?? o.model;
  if (!model) throw new Error("runBacktest needs a model or a modelFactory");
  const ex = new SimExecution(md, { now: () => clock, defer: queueMicrotask, latencyMs: o.latencyMs, respectSize: o.respectSize });
  const guard = new RiskGuard(o.cfg.dailyLossUsd);
  const events: FuturesEvent[] = [];
  const fills: BacktestFill[] = [];
  const skipped: Record<string, number> = {};
  const marks: BacktestResult["marks"] = {};
  const roots = o.roots.filter((r) => files.some((f) => f.root === r));
  for (const r of o.roots) if (!roots.includes(r)) log(`no data for ${r}; skipping it`);

  const traders = roots.map((root) => new FuturesTrader({
    root, md, ex, model, guard, cfg: o.cfg, liveOrders: false,
    now: () => new Date(clock),
    onEvent: (e) => events.push(e),
    onFill: (fill, p) => fills.push({ root, fill, position: p.qty }),
    log: (m) => log(`${new Date(clock).toISOString()} ${m}`),
  }));
  const step = o.cfg.decisionSeconds * 1000;
  let next: number[] = [];
  let started = false;
  let startTs = 0;
  let records = 0;
  let seen = ex.activity;
  const flush = async () => {
    while (seen !== ex.activity) { seen = ex.activity; await new Promise<void>((r) => setImmediate(r)); }
  };

  /** Run cycles and exchange arrivals due at or before `t`, earliest first. */
  const advance = async (t: number) => {
    for (;;) {
      const i = next.reduce((best, v, j) => (v < next[best]! ? j : best), 0);
      const cycleAt = next[i] ?? Infinity;
      const dueAt = ex.nextDue ?? Infinity;
      const at = Math.min(cycleAt, dueAt);
      if (at > t) return;
      clock = at;
      if (dueAt <= cycleAt) { ex.processDue(clock); await flush(); continue; }
      const trader = traders[i]!;
      next[i] = cycleAt + step;
      const b = md.book(trader.contract);
      if (!b || clock - b.ts > o.staleMs) { skipped[trader.contract.code] = (skipped[trader.contract.code] ?? 0) + 1; continue; }
      await trader.cycle();
      await flush();
    }
  };

  let day = "";
  let dayCycles = 0;
  let dayRecords = 0;
  for await (const { root, contract, rec } of mergeStreams(files)) {
    records++;
    if (!started) {
      if (!startTs) startTs = rec.t + o.warmupMinutes * 60_000;
      if (rec.t >= startTs) {
        clock = startTs;
        for (const t of traders) await t.start();
        next = traders.map((_, i) => startTs + (step * i) / traders.length);
        started = true;
        log(`warmup done at ${new Date(startTs).toISOString()}; trading ${traders.map((t) => t.contract.code).join(", ")}`);
      }
    }
    if (started) await advance(rec.t);
    clock = rec.t;
    md.apply(contract, rec);
    await flush();

    if (started && rec.k === "q") {
      const mid = (rec.b + rec.a) / 2;
      const m = (marks[root] ??= { first: mid, last: mid, firstTs: rec.t, lastTs: rec.t });
      m.last = mid; m.lastTs = rec.t;
    }
    const d = SPECS[root].session.tradingDay(new Date(rec.t));
    if (d !== day) {
      if (day) o.onDay?.(day, { cycles: events.length - dayCycles, records: records - 1 - dayRecords });
      day = d;
      dayCycles = events.length;
      dayRecords = records - 1;
    }
  }
  if (day) o.onDay?.(day, { cycles: events.length - dayCycles, records: records - dayRecords });
  if (!started) throw new Error(`the data ends inside the ${o.warmupMinutes} minute warmup`);
  for (const t of traders) { t.mark("end of data"); t.stop(); }

  const { model: _m, modelFactory: _f, onDay, log: _log, cfg, ...rest } = o;
  return {
    options: { ...rest, model: model.name, cfg: { ...cfg, stopTicks: Object.fromEntries(roots.map((r) => [r, cfg.stopTicks(r)])) } },
    files, records, events, fills, skipped, marks, startTs, endTs: clock, wallMs: Math.round(performance.now() - t0),
  };
}
