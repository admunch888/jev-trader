/**
 * bun run backtest [options]
 *
 *   --data <dir>          tick store (default data/ticks)
 *   --roots MES,ZB        default FUT_ROOTS
 *   --from / --to         trading days YYYY-MM-DD, inclusive (default: everything recorded)
 *   --latency <ms>        decision to exchange (default 250)
 *   --respect-size        cap marketable fills at the displayed touch size
 *   --warmup <min>        replay before the first decision (default 60)
 *   --stale <sec>         skip cycles when the last quote is older (default 120)
 *   --out <dir>           report directory (default data/backtests/<timestamp>)
 *   --synthetic <days>    generate seeded synthetic ticks into a temp store first and run on them
 *   --seed <n>            seed for --synthetic (default 1)
 *   --confirm-jev         required with MODEL=jev: every cycle is a paid Jev call
 *   --replay <files>      use the answers the live model already gave (comma separated logs, e.g.
 *                         data/futures-decisions.jsonl,data/futures-events.jsonl) instead of calling a model:
 *                         free, and --from/--to default to the logged span. Pair with the ticks recorded then.
 *
 * Strategy settings come from the same FUT_* variables as the live trader; these flags override the common ones:
 *   --decision-s --horizon-min --enter --flat-band --qty --max-contracts --stop-ticks --daily-loss --max-spread --slip-ticks
 *   --smooth <n> --min-hold <min> --allow-flip / --no-flip
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { futuresConfig, type FuturesConfig } from "../config";
import { SPECS } from "../contracts";
import { createFuturesModel } from "../model";
import type { Root } from "../types";
import { runBacktest } from "./engine";
import { printSummary, summarize, writeReport } from "./report";
import { LoggedModel, loadDecisions, NO_LOGGED } from "./logged";
import { generateSynthetic } from "./synth";

const { values: a } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: "string", default: "data/ticks" },
    roots: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    latency: { type: "string", default: "250" },
    "respect-size": { type: "boolean", default: false },
    warmup: { type: "string", default: "60" },
    stale: { type: "string", default: "120" },
    out: { type: "string" },
    synthetic: { type: "string" },
    seed: { type: "string", default: "1" },
    "confirm-jev": { type: "boolean", default: false },
    replay: { type: "string" },
    smooth: { type: "string" },
    "min-hold": { type: "string" },
    "allow-flip": { type: "boolean" },
    "no-flip": { type: "boolean" },
    quiet: { type: "boolean", default: false },
    "decision-s": { type: "string" },
    "horizon-min": { type: "string" },
    enter: { type: "string" },
    "flat-band": { type: "string" },
    qty: { type: "string" },
    "max-contracts": { type: "string" },
    "stop-ticks": { type: "string" },
    "daily-loss": { type: "string" },
    "max-spread": { type: "string" },
    "slip-ticks": { type: "string" },
  },
});

const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
const pick = <T>(v: T | undefined, d: T) => (v === undefined || Number.isNaN(v) ? d : v);
const roots = (a.roots ?? futuresConfig.roots.join(",")).split(",").map((s) => s.trim().toUpperCase()) as Root[];
for (const r of roots) if (!(r in SPECS)) throw new Error(`unknown root ${r}`);

const stopTicks = num(a["stop-ticks"]);
const cfg: FuturesConfig = {
  ...futuresConfig,
  roots,
  exec: "sim",
  decisionSeconds: pick(num(a["decision-s"]), futuresConfig.decisionSeconds),
  horizonMinutes: pick(num(a["horizon-min"]), futuresConfig.horizonMinutes),
  enterProb: pick(num(a.enter), futuresConfig.enterProb),
  flatBand: pick(num(a["flat-band"]), futuresConfig.flatBand),
  qty: pick(num(a.qty), futuresConfig.qty),
  maxContracts: pick(num(a["max-contracts"]), futuresConfig.maxContracts),
  dailyLossUsd: pick(num(a["daily-loss"]), futuresConfig.dailyLossUsd),
  maxSpreadTicks: pick(num(a["max-spread"]), futuresConfig.maxSpreadTicks),
  slipTicks: pick(num(a["slip-ticks"]), futuresConfig.slipTicks),
  stopTicks: stopTicks === undefined ? futuresConfig.stopTicks : () => stopTicks,
  smoothN: pick(num(a.smooth), futuresConfig.smoothN),
  minHoldMinutes: pick(num(a["min-hold"]), futuresConfig.minHoldMinutes),
  allowFlip: a["allow-flip"] ? true : a["no-flip"] ? false : futuresConfig.allowFlip,
};
if (cfg.qty > cfg.maxContracts) throw new Error(`--qty ${cfg.qty} is above --max-contracts ${cfg.maxContracts}`);

let dataDir = a.data!;
let from = a.from, to = a.to;
if (a.synthetic) {
  dataDir = mkdtempSync(join(tmpdir(), "jev-synth-"));
  const days = Number(a.synthetic);
  from ??= "2026-09-21";
  for (const [i, root] of roots.entries()) generateSynthetic({ dir: dataDir, root, from, days, seed: Number(a.seed) + i });
  to = undefined;
  console.log(`synthetic ticks: ${days} day(s) from ${from} for ${roots.join(",")} in ${dataDir} (random walk, not market data)`);
}

const replay = a.replay ? await loadDecisions(a.replay.split(",").map((s) => s.trim())) : null;
let replayModel: LoggedModel | null = null;
if (replay) {
  if (!replay.length) throw new Error(`no model answers found in ${a.replay}`);
  const span = { from: replay[0]!.ts, to: replay.at(-1)!.ts };
  const day = (ts: number) => SPECS[roots[0]!].session.tradingDay(new Date(ts));
  from ??= day(span.from);
  to ??= day(span.to);
  console.log(`replaying ${replay.length} logged model answers, ${new Date(span.from).toISOString().slice(0, 16)} to ${new Date(span.to).toISOString().slice(0, 16)} UTC`);
}
const model = replay ? null : createFuturesModel();
if (model && model.name !== "mock" && !a["confirm-jev"]) {
  const perDay = Math.round((23 * 3600) / cfg.decisionSeconds) * roots.length;
  throw new Error(`MODEL=jev makes a paid Jev call every cycle (about ${perDay.toLocaleString("en-US")} per trading day for ${roots.length} root(s) at ${cfg.decisionSeconds}s). Re-run with --confirm-jev.`);
}

const result = await runBacktest({
  dataDir, roots, from, to, cfg,
  ...(replay ? { modelFactory: (clock: () => number) => (replayModel = new LoggedModel(replay, clock, cfg.decisionSeconds * 2000)) } : { model: model! }),
  latencyMs: Number(a.latency),
  respectSize: a["respect-size"]!,
  warmupMinutes: Number(a.warmup),
  staleMs: Number(a.stale) * 1000,
  onDay: (day, s) => { if (!a.quiet) console.log(`  ${day}: ${s.records.toLocaleString("en-US")} records, ${s.cycles} cycles`); },
  log: a.quiet ? undefined : (m) => { if (!m.includes(NO_LOGGED)) console.log(`  ${m}`); },
});
const summary = summarize(result);
printSummary(summary);
if (replayModel) {
  const rm = replayModel as LoggedModel;
  console.log(`  replay: ${rm.hits} cycles used a logged answer, ${rm.misses} had none within ${cfg.decisionSeconds * 2}s and held`);
}
console.log(`  policy: enter ${cfg.enterProb}, flat band ${cfg.flatBand}, average of ${cfg.smoothN}, min hold ${cfg.minHoldMinutes}m, flips ${cfg.allowFlip ? "allowed" : "flat first"}`);
const out = a.out ?? join("data", "backtests", new Date().toISOString().replace(/[:.]/g, "-"));
writeReport(out, result, summary);
console.log(`report: ${out}/summary.json, trades.csv, equity.csv, cycles.jsonl`);
process.exit(0);
