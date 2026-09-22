/**
 * bun run analyze [--decisions data/futures-decisions.jsonl,data/futures-v2-decisions.jsonl] [--root MES] [--data data/ticks]
 *                 [--from <ISO>] [--to <ISO>] [--all-times] [--horizon <min>]
 *
 * How good are a model's calls, independent of the trading rules? For every logged call, the recorded mid 1 minute
 * and `--horizon` minutes (default 5, the question the bot asks) later: hit rate, correlation of P(up) with the past and the next 5 minutes (chasing shows as a high
 * past and a low next), average move after each probability level, and what strong calls captured per call
 * against the round trip cost. With several logs it compares them over the time they overlap (so both face the
 * same market) unless --all-times. Needs the ticks recorded for those times (`bun run record`).
 *
 * Calibration: does P(up) = 0.7 come true about 70% of the time? A reliability table by probability level, Brier
 * score against always answering the base rate, log loss, expected calibration error, and a fitted recalibration
 * (logistic on the log-odds): slope 1 means well calibrated, below 1 overconfident, near 0 no information at all.
 */
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { SPECS } from "../contracts";
import type { Root } from "../types";
import { indexTicks, readLines, readTickFile } from "./format";

export interface Call { ts: number; contract: string; up: number; costTicks: number | null }
export interface Series { t: number[]; mid: number[] }

export interface CallStats {
  calls: number;
  strong: number;
  hit1: number | null; hit5: number | null; hitStrong5: number | null;
  corrPast5: number | null; corrNext1: number | null; corrNext5: number | null;
  /** Average move over the horizon in the called direction, strong calls only, in ticks (before costs). "5" fields are the horizon. */
  capturedStrong5: number | null;
  avgCostTicks: number | null;
  meanSwing: number | null;
  buckets: { label: string; calls: number; past5: number; next5: number }[];
  calibration: Calibration | null;
}

export interface Calibration {
  /** Calls whose mid moved over the horizon (ties are left out: neither up nor down). */
  n: number;
  ties: number;
  /** Share of those that ended higher. */
  baseRate: number;
  brier: number;
  /** Brier of always answering the base rate; the model must beat it to add anything. */
  brierBase: number;
  /** 1 - brier / brierBase: above 0 is better than the base rate, 0 or below adds nothing. */
  brierSkill: number;
  logLoss: number;
  /** Expected calibration error over 10 bins: average gap between stated P(up) and how often it came true. */
  ece: number;
  /** P(true up) = sigmoid(a + b * logit(P(up))), fitted on these calls. */
  fit: { a: number; b: number } | null;
  bins: { lo: number; hi: number; n: number; meanP: number; freqUp: number }[];
}

const clip = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p: number) => Math.log(clip(p) / (1 - clip(p)));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** How well stated probabilities match outcomes. `ys` are 1 (went up) or 0; null with under 10 outcomes. */
export function calibrate(ps: number[], ys: number[], ties = 0): Calibration | null {
  const n = ps.length;
  if (n < 10) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const base = mean(ys);
  const brier = mean(ps.map((p, i) => (p - ys[i]!) ** 2));
  const brierBase = base * (1 - base);
  const logLoss = mean(ps.map((p, i) => -(ys[i]! * Math.log(clip(p)) + (1 - ys[i]!) * Math.log(1 - clip(p)))));
  const bins: Calibration["bins"] = [];
  let ece = 0;
  for (let k = 0; k < 10; k++) {
    const lo = k / 10, hi = (k + 1) / 10;
    const idx = ps.map((p, i) => [p, i] as const).filter(([p]) => p >= lo && (k === 9 ? p <= hi : p < hi)).map(([, i]) => i);
    if (!idx.length) continue;
    const meanP = mean(idx.map((i) => ps[i]!)), freqUp = mean(idx.map((i) => ys[i]!));
    bins.push({ lo, hi, n: idx.length, meanP, freqUp });
    ece += (idx.length / n) * Math.abs(meanP - freqUp);
  }
  return {
    n, ties, baseRate: base, brier, brierBase, brierSkill: brierBase ? 1 - brier / brierBase : 0, logLoss, ece,
    fit: fitLogistic(ps.map(logit), ys), bins,
  };
}

/** Two-parameter logistic regression by Newton's method, with a little ridge so it settles on degenerate data. */
function fitLogistic(xs: number[], ys: number[]): { a: number; b: number } | null {
  let a = 0, b = 1;
  for (let it = 0; it < 50; it++) {
    let ga = 0, gb = 0, haa = 1e-6, hab = 0, hbb = 1e-6;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!, p = sigmoid(a + b * x), w = p * (1 - p), e = p - ys[i]!;
      ga += e; gb += e * x + 1e-3 * b; haa += w; hab += w * x; hbb += w * x * x + 1e-3;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) return null;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return Number.isFinite(a) && Number.isFinite(b) ? { a, b } : null;
}

const BUCKETS: [string, number, number][] = [["<=20%", 0, 0.2], ["20-35%", 0.2, 0.35], ["35-65%", 0.35, 0.65], ["65-80%", 0.65, 0.8], [">=80%", 0.8, 1.01]];

/** Score calls against mids (per contract code), in ticks of `tick`, over `horizonMin`. Calls without that much price history before and after are left out. */
export function scoreCalls(calls: Call[], mids: Map<string, Series>, tick: number, strongAt = 0.15, horizonMin = 5): CallStats {
  const H = horizonMin * 60_000;
  const midAt = (code: string, t: number) => {
    const s = mids.get(code);
    if (!s || !s.t.length || t < s.t[0]! || t > s.t.at(-1)!) return null;
    let lo = 0, hi = s.t.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (s.t[m]! <= t) { at = m; lo = m + 1; } else hi = m - 1; }
    return at >= 0 ? s.mid[at]! : null;
  };
  const rows: { up: number; past5: number; f1: number; f5: number; cost: number | null }[] = [];
  for (const c of calls) {
    const m0 = midAt(c.contract, c.ts), mp = midAt(c.contract, c.ts - H), m1 = midAt(c.contract, c.ts + 60_000), m5 = midAt(c.contract, c.ts + H);
    if (m0 === null || mp === null || m1 === null || m5 === null) continue;
    rows.push({ up: c.up, past5: (m0 - mp) / tick, f1: (m1 - m0) / tick, f5: (m5 - m0) / tick, cost: c.costTicks });
  }
  const strong = rows.filter((r) => Math.abs(r.up - 0.5) >= strongAt);
  const hit = (rs: typeof rows, k: "f1" | "f5") => {
    const moved = rs.filter((r) => r[k] !== 0 && r.up !== 0.5);
    return moved.length ? moved.filter((r) => (r.up > 0.5) === (r[k] > 0)).length / moved.length : null;
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const costs = rows.map((r) => r.cost).filter((c): c is number => c !== null);
  return {
    calls: rows.length,
    strong: strong.length,
    hit1: hit(rows, "f1"), hit5: hit(rows, "f5"), hitStrong5: hit(strong, "f5"),
    corrPast5: corr(rows.map((r) => r.up), rows.map((r) => r.past5)),
    corrNext1: corr(rows.map((r) => r.up), rows.map((r) => r.f1)),
    corrNext5: corr(rows.map((r) => r.up), rows.map((r) => r.f5)),
    capturedStrong5: mean(strong.map((r) => Math.sign(r.up - 0.5) * r.f5)),
    avgCostTicks: mean(costs),
    meanSwing: rows.length > 1 ? mean(rows.slice(1).map((r, i) => Math.abs(r.up - rows[i]!.up))) : null,
    buckets: BUCKETS.map(([label, lo, hi]) => {
      const b = rows.filter((r) => r.up >= lo && r.up < hi);
      return { label, calls: b.length, past5: mean(b.map((r) => r.past5)) ?? 0, next5: mean(b.map((r) => r.f5)) ?? 0 };
    }),
    calibration: (() => {
      const moved = rows.filter((r) => r.f5 !== 0);
      return calibrate(moved.map((r) => r.up), moved.map((r) => (r.f5 > 0 ? 1 : 0)), rows.length - moved.length);
    })(),
  };
}

export function corr(x: number[], y: number[]): number | null {
  if (x.length < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i]! - mx, dy = y[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

async function loadCalls(path: string, root: Root): Promise<{ calls: Call[]; label: string }> {
  const calls: Call[] = [];
  const tags = new Set<string>();
  for await (const line of readLines(path)) {
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.root !== root || !r.probabilities || r.model === "mock" || r.model === "replay") continue;
    calls.push({ ts: r.ts, contract: r.contract, up: r.probabilities.buy, costTicks: r.state?.costTicks ?? null });
    tags.add(`${r.model ?? "?"} ${r.stateVersion ?? "v1"}`);
  }
  return { calls: calls.sort((a, b) => a.ts - b.ts), label: `${basename(path)} (${[...tags].join(", ") || "no calls"})` };
}

async function loadMids(dir: string, root: Root, from: number, to: number): Promise<Map<string, Series>> {
  const day = (ts: number) => SPECS[root].session.tradingDay(new Date(ts));
  const out = new Map<string, Series>();
  for (const f of indexTicks(dir, [root], day(from), day(to + 600_000))) {
    const s = out.get(f.code) ?? { t: [], mid: [] };
    for await (const r of readTickFile(f.path)) if (r.k === "q") { s.t.push(r.t); s.mid.push((r.b + r.a) / 2); }
    out.set(f.code, s);
  }
  return out;
}

if (import.meta.main) {
  const { values: a } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      decisions: { type: "string", default: "data/futures-decisions.jsonl" },
      root: { type: "string", default: "MES" },
      data: { type: "string", default: "data/ticks" },
      from: { type: "string" }, to: { type: "string" },
      "all-times": { type: "boolean", default: false },
      horizon: { type: "string", default: "5" },
    },
  });
  const root = a.root!.toUpperCase() as Root;
  const spec = SPECS[root];
  const logs = await Promise.all(a.decisions!.split(",").map((p) => loadCalls(p.trim(), root)));
  let from = a.from ? Date.parse(a.from) : -Infinity, to = a.to ? Date.parse(a.to) : Infinity;
  if (logs.length > 1 && !a["all-times"]) {
    from = Math.max(from, ...logs.map((l) => l.calls[0]?.ts ?? Infinity));
    to = Math.min(to, ...logs.map((l) => l.calls.at(-1)?.ts ?? -Infinity));
  }
  const inWindow = logs.map((l) => ({ ...l, calls: l.calls.filter((c) => c.ts >= from && c.ts <= to) }));
  const all = inWindow.flatMap((l) => l.calls);
  if (!all.length) throw new Error(`no ${root} calls${logs.length > 1 ? " in the time the logs overlap" : ""}`);
  const lo = Math.min(...all.map((c) => c.ts)), hi = Math.max(...all.map((c) => c.ts));
  const H = Number(a.horizon);
  const mids = await loadMids(a.data!, root, lo, hi + H * 60_000);
  const iso = (ts: number) => new Date(ts).toISOString().slice(0, 16);
  console.log(`${root} calls ${iso(lo)} to ${iso(hi)} UTC${logs.length > 1 && !a["all-times"] ? " (overlap of all logs)" : ""}; moves in ticks of ${spec.tickSize}`);

  const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(0)}%`);
  const num = (x: number | null, d = 2) => (x === null ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
  const stats = inWindow.map((l) => ({ label: l.label, s: scoreCalls(l.calls, mids, spec.tickSize, 0.15, H) }));
  const w = 44;
  const row = (name: string, f: (s: CallStats) => string) => console.log(`  ${name.padEnd(46)}${stats.map((x) => f(x.s).padStart(w)).join("")}`);
  console.log(`  ${"".padEnd(46)}${stats.map((x) => x.label.slice(0, w - 2).padStart(w)).join("")}`);
  row("calls scored (strong: <=35% or >=65%)", (s) => `${s.calls} (${s.strong} strong)`);
  row(`direction right after 1 min / ${H} min`, (s) => `${pct(s.hit1)} / ${pct(s.hit5)}`);
  row(`strong calls right after ${H} min`, (s) => pct(s.hitStrong5));
  row(`P(up) vs PAST ${H} min (high = chasing)`, (s) => num(s.corrPast5));
  row(`P(up) vs NEXT 1 min / ${H} min (want high)`, (s) => `${num(s.corrNext1)} / ${num(s.corrNext5)}`);
  row(`strong calls: ticks captured in ${H} min`, (s) => num(s.capturedStrong5, 1));
  row("  vs round trip cost (ticks)", (s) => (s.avgCostTicks === null ? "-" : s.avgCostTicks.toFixed(1)));
  row("average swing between calls (points)", (s) => (s.meanSwing === null ? "-" : (s.meanSwing * 100).toFixed(0)));
  for (const [i, [label]] of BUCKETS.entries()) {
    row(`P(up) ${label}: calls, past ${H}m -> next ${H}m`, (s) => { const b = s.buckets[i]!; return b.calls ? `${b.calls}: ${num(b.past5, 1)} -> ${num(b.next5, 1)}` : "-"; });
  }
  console.log(`\n  Calibration: P(up) against how often the mid was higher after ${H} min (ties left out)`);
  const cal = (f: (c: Calibration) => string) => (s: CallStats) => (s.calibration ? f(s.calibration) : "too few");
  row("calls that moved (ties)", cal((c) => `${c.n} (${c.ties})`));
  row("went up (base rate)", cal((c) => pct(c.baseRate)));
  row("Brier (base rate alone) skill", cal((c) => `${c.brier.toFixed(4)} (${c.brierBase.toFixed(4)}) ${num(c.brierSkill, 3)}`));
  row("log loss (0.693 = coin flip)", cal((c) => c.logLoss.toFixed(3)));
  row("calibration error (ECE)", cal((c) => `${(c.ece * 100).toFixed(1)} pts`));
  row("recalibration slope (1 good, 0 no info)", cal((c) => (c.fit ? `${c.fit.b.toFixed(2)} (shift ${num(c.fit.a, 2)})` : "-")));
  for (let k = 0; k < 10; k++) {
    const lo = k / 10;
    if (!stats.some((x) => x.s.calibration?.bins.some((b) => b.lo === lo))) continue;
    row(`  said ${Math.round(lo * 100)}-${Math.round(lo * 100 + 10)}%: calls, avg said -> came true`, cal((c) => {
      const b = c.bins.find((x) => x.lo === lo);
      return b ? `${b.n}: ${pct(b.meanP)} -> ${pct(b.freqUp)}` : "-";
    }));
  }
  console.log(`  Note: Jev is asked whether the mid will be higher by more than the cost, so its P(up) should sit nearer 50% than`);
  console.log(`  a plain up/down probability would; the slope and Brier skill are the fair tests.`);
  console.log(`\n  A model worth trading shows: strong calls capturing clearly more ticks than the round trip cost, a positive`);
  console.log(`  NEXT correlation, and next-5m moves that rise with P(up). One session is noise; compare several.`);
}
