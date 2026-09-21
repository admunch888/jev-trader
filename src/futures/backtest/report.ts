import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatPrice, pnlUsd, SPECS } from "../contracts";
import type { Root } from "../types";
import type { BacktestFill, BacktestResult } from "./engine";

export interface RoundTrip {
  root: Root;
  contract: string;
  side: "long" | "short";
  /** Largest size held during the trip. */
  qty: number;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
}

/**
 * Flat to flat, per root. A flip closes one trip and opens the next at the flip price; a fill's fees are split
 * between the trips by quantity.
 */
export function roundTrips(fills: BacktestFill[]): RoundTrip[] {
  const out: RoundTrip[] = [];
  const open = new Map<Root, { pos: number; avg: number; trip: RoundTrip; exitQty: number; exitValue: number }>();
  for (const { root, fill: f } of fills) {
    const spec = SPECS[root];
    const signed = f.side === "buy" ? f.qty : -f.qty;
    const feePer = (f.commission ?? spec.estFeesPerSide * f.qty) / f.qty;
    let s = open.get(root);
    const openTrip = (qty: number) => {
      s = { pos: 0, avg: f.price, exitQty: 0, exitValue: 0, trip: { root, contract: f.contract, side: qty > 0 ? "long" : "short", qty: 0, entryTs: f.ts, exitTs: 0, entryPrice: f.price, exitPrice: 0, grossUsd: 0, feesUsd: 0, netUsd: 0 } };
      open.set(root, s);
    };
    if (!s || !s.pos) openTrip(signed);
    if (Math.sign(signed) === Math.sign(s!.pos) || !s!.pos) {
      s!.avg = (s!.avg * Math.abs(s!.pos) + f.price * f.qty) / (Math.abs(s!.pos) + f.qty);
      s!.pos += signed;
      s!.trip.entryPrice = s!.avg;
      s!.trip.qty = Math.max(s!.trip.qty, Math.abs(s!.pos));
      s!.trip.feesUsd += feePer * f.qty;
      continue;
    }
    const closing = Math.min(f.qty, Math.abs(s!.pos));
    s!.trip.grossUsd += pnlUsd(spec, Math.sign(s!.pos) * closing, s!.avg, f.price);
    s!.trip.feesUsd += feePer * closing;
    s!.exitQty += closing;
    s!.exitValue += closing * f.price;
    s!.pos += Math.sign(signed) * closing;
    if (!s!.pos) {
      const t = s!.trip;
      t.exitTs = f.ts;
      t.exitPrice = s!.exitValue / s!.exitQty;
      t.netUsd = t.grossUsd - t.feesUsd;
      out.push(t);
      open.delete(root);
      const rest = f.qty - closing;
      if (rest) {
        openTrip(Math.sign(signed) * rest);
        s!.pos = Math.sign(signed) * rest;
        s!.trip.qty = rest;
        s!.trip.feesUsd = feePer * rest;
      }
    }
  }
  return out;
}

/** Largest peak to trough fall of an equity series, in USD, and when it happened. */
export function maxDrawdown(equity: { ts: number; usd: number }[]) {
  let peak = -Infinity, peakTs = 0, dd = 0, from = 0, to = 0;
  for (const p of equity) {
    if (p.usd > peak) { peak = p.usd; peakTs = p.ts; }
    if (peak - p.usd > dd) { dd = peak - p.usd; from = peakTs; to = p.ts; }
  }
  return { usd: dd, from, to };
}

/** Account equity (realized + unrealized - fees, summed over roots) after every cycle. */
export function equityCurve(r: BacktestResult) {
  const latest = new Map<string, number>();
  return r.events.map((e) => {
    latest.set(e.root, e.totals.pnlUsd);
    let usd = 0;
    for (const v of latest.values()) usd += v;
    return { ts: e.ts, usd };
  });
}

export function summarize(r: BacktestResult) {
  const trips = roundTrips(r.fills);
  const equity = equityCurve(r);
  const last = new Map<Root, BacktestResult["events"][number]>();
  for (const e of r.events) last.set(e.root, e);
  const roots = [...last.keys()];

  const sum = (f: (e: BacktestResult["events"][number]) => number) => roots.reduce((s, k) => s + f(last.get(k)!), 0);
  const netUsd = sum((e) => e.totals.pnlUsd);
  const realizedUsd = sum((e) => e.totals.realizedUsd);
  const feesUsd = sum((e) => e.totals.feesUsd);
  const jevUsd = sum((e) => e.totals.jevUsd);
  const openUsd = sum((e) => e.position.unrealizedUsd);

  const wins = trips.filter((t) => t.netUsd > 0), losses = trips.filter((t) => t.netUsd <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netUsd, 0), grossLoss = -losses.reduce((s, t) => s + t.netUsd, 0);

  // Daily PnL: equity at the end of each trading day minus the end of the previous one.
  const byDay = new Map<string, number>();
  for (const p of equity) byDay.set(SPECS[roots[0] ?? "MES"].session.tradingDay(new Date(p.ts)), p.usd);
  const daily: { day: string; pnlUsd: number }[] = [];
  let prev = 0;
  for (const [day, usd] of byDay) { daily.push({ day, pnlUsd: round(usd - prev) }); prev = usd; }
  const mean = daily.reduce((s, d) => s + d.pnlUsd, 0) / (daily.length || 1);
  const sd = Math.sqrt(daily.reduce((s, d) => s + (d.pnlUsd - mean) ** 2, 0) / Math.max(1, daily.length - 1));

  const cycles = r.events.filter((e) => !e.decision?.late).length;
  const gates: Record<string, number> = {};
  for (const e of r.events) if (e.gate) gates[e.gate] = (gates[e.gate] ?? 0) + 1;

  const perRoot = roots.map((root) => {
    const e = last.get(root)!, spec = SPECS[root], m = r.marks[root];
    const rt = trips.filter((t) => t.root === root);
    const inPos = r.events.filter((x) => x.root === root && x.position.qty !== 0).length;
    const all = r.events.filter((x) => x.root === root).length;
    const qty = (r.options.cfg.qty as number) ?? 1;
    return {
      root, contract: e.contract,
      netUsd: round(e.totals.pnlUsd), realizedUsd: round(e.totals.realizedUsd), feesUsd: round(e.totals.feesUsd), openUsd: round(e.position.unrealizedUsd),
      trips: rt.length, winRate: rt.length ? round(rt.filter((t) => t.netUsd > 0).length / rt.length, 3) : null,
      exposure: all ? round(inPos / all, 3) : 0,
      decisions: e.totals.decisions, orders: e.totals.orders, fills: e.totals.fills, rejects: e.totals.rejects,
      buyAndHoldUsd: m ? round(pnlUsd(spec, qty, m.first, m.last) - 2 * spec.estFeesPerSide * qty) : null,
      firstMid: m ? formatPrice(spec, m.first) : null, lastMid: m ? formatPrice(spec, m.last) : null,
    };
  });

  return {
    period: { from: new Date(r.startTs).toISOString(), to: new Date(r.endTs).toISOString(), tradingDays: daily.length },
    netUsd: round(netUsd), realizedUsd: round(realizedUsd), openUsd: round(openUsd), feesUsd: round(feesUsd), jevUsd: round(jevUsd, 4),
    trips: trips.length,
    winRate: trips.length ? round(wins.length / trips.length, 3) : null,
    avgWinUsd: wins.length ? round(grossWin / wins.length) : null,
    avgLossUsd: losses.length ? round(-grossLoss / losses.length) : null,
    profitFactor: grossLoss ? round(grossWin / grossLoss, 2) : null,
    expectancyUsd: trips.length ? round((grossWin - grossLoss) / trips.length) : null,
    avgHoldMin: trips.length ? round(trips.reduce((s, t) => s + (t.exitTs - t.entryTs), 0) / trips.length / 60_000, 1) : null,
    maxDrawdownUsd: round(maxDrawdown(equity).usd),
    /** Annualized from daily PnL; only reported with at least 5 trading days, and noisy until far more. */
    dailySharpe: daily.length >= 5 && sd > 0 ? round((mean / sd) * Math.sqrt(252), 2) : null,
    cycles, skippedCycles: r.skipped, gates,
    perRoot, daily,
    run: { records: r.records, files: r.files.length, wallMs: r.wallMs, model: r.options.model, latencyMs: r.options.latencyMs, respectSize: r.options.respectSize },
  };
}

export type Summary = ReturnType<typeof summarize>;

export function printSummary(s: Summary, print: (line: string) => void = console.log) {
  const usd = (x: number | null) => (x === null ? "-" : `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`);
  const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);
  print(`backtest ${s.period.from.slice(0, 16)} to ${s.period.to.slice(0, 16)} UTC, ${s.period.tradingDays} trading day(s), model ${s.run.model}, latency ${s.run.latencyMs} ms${s.run.respectSize ? ", touch size capped" : ""}`);
  print(`  net ${usd(s.netUsd)}  (realized ${usd(s.realizedUsd)}, open ${usd(s.openUsd)}, fees ${usd(s.feesUsd)})${s.jevUsd ? `  jev ${usd(s.jevUsd)}` : ""}`);
  print(`  trips ${s.trips}  win ${pct(s.winRate)}  avg win ${usd(s.avgWinUsd)}  avg loss ${usd(s.avgLossUsd)}  PF ${s.profitFactor ?? "-"}  expectancy ${usd(s.expectancyUsd)}  hold ${s.avgHoldMin ?? "-"} min`);
  print(`  max drawdown ${usd(s.maxDrawdownUsd)}  daily Sharpe ${s.dailySharpe ?? "- (needs 5+ days)"}  cycles ${s.cycles}${Object.keys(s.gates).length ? `  gates ${Object.entries(s.gates).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
  const skipped = Object.entries(s.skippedCycles);
  if (skipped.length) print(`  skipped on stale data: ${skipped.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const r of s.perRoot) {
    print(`  ${r.contract.padEnd(6)} net ${usd(r.netUsd).padStart(10)}  trips ${String(r.trips).padStart(4)}  win ${pct(r.winRate).padStart(6)}  in market ${pct(r.exposure).padStart(6)}  fills ${r.fills}  rejects ${r.rejects}  | buy and hold ${usd(r.buyAndHoldUsd)} (${r.firstMid} -> ${r.lastMid})`);
  }
  print(`  ${s.run.records.toLocaleString("en-US")} records from ${s.run.files} file(s) in ${(s.run.wallMs / 1000).toFixed(1)} s`);
}

/** summary.json, trades.csv, equity.csv, cycles.jsonl under `dir`. */
export function writeReport(dir: string, r: BacktestResult, s: Summary) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), JSON.stringify({ summary: s, options: r.options }, null, 2));
  const trips = roundTrips(r.fills);
  writeFileSync(join(dir, "trades.csv"), [
    "root,contract,side,qty,entry_time,exit_time,entry_price,exit_price,gross_usd,fees_usd,net_usd",
    ...trips.map((t) => [t.root, t.contract, t.side, t.qty, iso(t.entryTs), iso(t.exitTs), t.entryPrice, t.exitPrice, round(t.grossUsd), round(t.feesUsd), round(t.netUsd)].join(",")),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "equity.csv"), ["time,equity_usd", ...equityCurve(r).map((p) => `${iso(p.ts)},${round(p.usd)}`)].join("\n") + "\n");
  writeFileSync(join(dir, "cycles.jsonl"), r.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const iso = (ts: number) => new Date(ts).toISOString();
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
