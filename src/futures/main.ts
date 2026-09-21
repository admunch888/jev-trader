/**
 * Futures trader: one FuturesTrader per root in FUT_ROOTS, sharing one IBKR market data connection, one
 * execution (simulated or IBKR) and one account-wide daily loss guard.
 *
 *   FUT_EXEC=sim   bun run futures    real IBKR quotes, simulated fills, nothing sent (default)
 *   FUT_EXEC=ibkr  bun run futures    orders to IBKR; paper unless IB_LIVE=true and IB_PORT is a live port
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { futuresConfig as cfg } from "./config";
import { formatPrice, SPECS } from "./contracts";
import { IbkrExecution } from "./ibkr/execution";
import { IbkrMarketData } from "./ibkr/marketData";
import { ibConfig, isPaperPort } from "./ibkr/config";
import { createFuturesModel } from "./model";
import { RiskGuard } from "./policy";
import { startFuturesServer } from "./server";
import { SimExecution } from "./sim";
import { FuturesTrader, type FuturesEvent } from "./trader";
import type { Execution } from "./types";

for (const r of cfg.roots) if (!(r in SPECS)) throw new Error(`FUT_ROOTS: unknown root ${r} (supported: ${Object.keys(SPECS).join(", ")})`);
if (cfg.qty > cfg.maxContracts) throw new Error(`FUT_QTY ${cfg.qty} is above FUT_MAX_CONTRACTS ${cfg.maxContracts}`);

mkdirSync("data", { recursive: true });
const md = new IbkrMarketData();
await md.connect();
const ex: Execution = cfg.exec === "ibkr" ? new IbkrExecution() : new SimExecution(md);
await ex.connect();
if (cfg.exec === "ibkr" && cfg.cancelOnStart) {
  console.log("cancelling all open orders on the account (FUT_CANCEL_ON_START=true)");
  await ex.cancelAll();
}

const model = createFuturesModel();
const guard = new RiskGuard(cfg.dailyLossUsd);
const traders: FuturesTrader[] = [];
const allHistory = () => traders.flatMap((t) => t.history).sort((a, b) => a.ts - b.ts);
const server = startFuturesServer(cfg.port, { model: model.name, exec: cfg.exec, roots: cfg.roots, startedAt: Date.now() }, allHistory);

for (const root of cfg.roots) {
  const t = new FuturesTrader({
    root, md, ex, model, guard, cfg,
    liveOrders: cfg.exec === "ibkr",
    onEvent: (e) => { server.broadcastCycle(e); appendFileSync("data/futures-events.jsonl", JSON.stringify(e) + "\n"); logCycle(e); },
    onDecision: (r) => appendFileSync("data/futures-decisions.jsonl", JSON.stringify(r) + "\n"),
    onFill: (f, p) => {
      server.broadcastFill(f);
      const spec = SPECS[p.root];
      console.log(`[${p.root}] FILL ${f.side} ${f.qty} ${f.contract} @ ${formatPrice(spec, f.price)} fee ${f.commission ?? "?"} -> position ${p.qty}${p.avgPrice !== null ? ` @ ${formatPrice(spec, p.avgPrice)}` : ""}`);
    },
  });
  await t.start();
  traders.push(t);
  const cal = t.contract.calendar;
  console.log(`[${root}] trading ${t.contract.code} (conId ${t.contract.brokerId ?? "-"}), roll ${cal.rollDate.toISOString().slice(0, 10)}${cal.firstNoticeDate ? `, first notice ${cal.firstNoticeDate.toISOString().slice(0, 10)}` : ""}, position ${t.position.qty}`);
}

const mode = cfg.exec === "sim" ? "SIM (no orders sent)" : isPaperPort(ibConfig.port) ? "IBKR PAPER" : "IBKR LIVE";
console.log(`futures · ${mode} · model=${model.name} · roots ${cfg.roots.join(",")} · every ${cfg.decisionSeconds}s · horizon ${cfg.horizonMinutes}m · qty ${cfg.qty} max ${cfg.maxContracts} · daily loss $${cfg.dailyLossUsd} · :${cfg.port}`);
console.log(`policy · enter ${cfg.enterProb} · flat band ${cfg.flatBand} · average of ${cfg.smoothN} · min hold ${cfg.minHoldMinutes}m · flips ${cfg.allowFlip ? "allowed" : "go flat first"} · decisions logged to data/futures-decisions.jsonl`);

// Startup data check: say plainly what is flowing per root, and what the bot does if it is not.
setTimeout(() => {
  for (const t of traders) {
    const h = md.health(t.contract);
    const quotes = h.quotes === "live" ? "live quotes" : h.quotes === "delayed" ? "DELAYED quotes (15 min)" : "NO quotes";
    const prints = h.prints === "live" ? "trades on" : "no trades";
    let then = "";
    if (h.quotes === "none") then = `: it will not trade ${t.contract.code} and retries every ${ibConfig.dataRetrySeconds}s${h.reason ? ` (${h.reason}; fix in the ibkr md message above)` : ""}`;
    else if (h.quotes === "delayed") then = cfg.exec === "ibkr" ? ": delayed data never opens positions with real orders" : ": fine for checking the plumbing, not for judging the strategy";
    else if (h.prints === "none") then = `: trade flow inputs empty${h.reason ? ` (${h.reason})` : ""}`;
    console.log(`[${t.contract.root}] data check: ${quotes}, ${prints}${then}`);
  }
}, 5_000);

// Stagger the roots across the interval so model calls and orders do not bunch up.
const timers: ReturnType<typeof setInterval>[] = [];
traders.forEach((t, i) => {
  const offset = (cfg.decisionSeconds * 1000 * i) / traders.length;
  setTimeout(() => { void t.cycle(); timers.push(setInterval(() => void t.cycle(), cfg.decisionSeconds * 1000)); }, offset);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping decisions${cfg.flattenOnExit ? ", flattening" : ""}; protective stops stay working at the broker`);
  timers.forEach(clearInterval);
  if (cfg.flattenOnExit) { await Promise.all(traders.map((t) => t.flatten())); await Bun.sleep(3000); }
  traders.forEach((t) => t.stop());
  await ex.close();
  await md.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

function logCycle(e: FuturesEvent) {
  const spec = SPECS[e.root];
  const px = (x: number | null) => (x === null ? "-" : formatPrice(spec, x));
  const d = e.decision;
  const avg = d?.upUsed != null && cfg.smoothN > 1 ? ` avg ${(d.upUsed * 100).toFixed(0)}%` : "";
  const call = !d ? "no call" : d.late ? "LATE" : `up ${(d.probabilities.buy * 100).toFixed(0)}%${avg} ${d.latencyMs}ms`;
  const order = e.order ? ` -> ${e.order.side.toUpperCase()} ${e.order.qty} @ ${px(e.order.price)}` : "";
  const gate = e.gate ? ` [${e.gate}${e.gateDetail ? `: ${e.gateDetail}` : ""}]` : "";
  const stop = e.stop ? ` stop ${px(e.stop.price)}` : "";
  const notes = e.notes.length ? ` (${e.notes.join("; ")})` : "";
  console.log(`[${e.root}] ${e.contract} ${px(e.bid)}/${px(e.ask)} ${call} pos ${e.position.qty}${order}${gate}${stop} pnl $${e.totals.pnlUsd} today $${e.totals.pnlTodayUsd}${e.halted ? " HALTED" : ""}${notes}`);
}
