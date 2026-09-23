import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, Model } from "../../model";
import { futuresConfig, type FuturesConfig } from "../config";
import { frontContract } from "../contracts";
import type { FuturesTradeState } from "../model";
import { ManualMarketData, SimExecution } from "../sim";
import type { ExecFill, OrderUpdate } from "../types";
import { runBacktest, type BacktestOptions } from "./engine";
import { indexTicks, pageTicks, readTickFile, spreadWithinSecond, tickPath, TickWriter } from "./format";
import { mergeStreams } from "./replay";
import { LoggedModel, loadDecisions } from "./logged";
import { maxDrawdown, roundTrips, summarize } from "./report";
import { generateSynthetic } from "./synth";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "jev-bt-")); dirs.push(d); return d; };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

class ConstModel implements Model<FuturesTradeState> {
  readonly name = "mock";
  constructor(private p: number) {}
  async decide(): Promise<Decision> {
    return { action: this.p >= 0.5 ? "buy" : "sell", probabilities: { buy: this.p, sell: 1 - this.p, hold: 0 }, upIn10: this.p, latencyMs: 0, inputTokens: 0 };
  }
}

const cfg: FuturesConfig = {
  ...futuresConfig, roots: ["MES"], decisionSeconds: 30, horizonMinutes: 5, qty: 1, maxContracts: 1, enterProb: 0.6, flatBand: 0.05,
  smoothN: 1, minHoldMinutes: 0, allowFlip: true,
  slipTicks: 0, maxSpreadTicks: 2, stopTicks: () => 16, dailyLossUsd: 10_000, entryCutoffMinutes: 10, flattenBeforeWeekendMinutes: 15,
  reconcileEveryCycles: 1_000, orderTimeoutMs: 30_000, depthRows: 0,
  chaseSigma: 0, chaseMinutes: 5, takeProfitTicks: () => 0, trailStartTicks: () => 0, trailTicks: () => 0, entryMode: "cross", passiveCycles: 2,
};
const base = (dataDir: string, over: Partial<BacktestOptions> = {}): BacktestOptions => ({
  dataDir, roots: ["MES"], cfg, model: new ConstModel(0.9), latencyMs: 250, respectSize: false, warmupMinutes: 1, staleMs: 120_000, ...over,
});

const T0 = Date.parse("2026-09-22T14:00:00Z"); // Tue 09:00 Chicago
const DAY = "2026-09-22";
const MES = frontContract("MES", new Date(T0)); // MESZ6

describe("tick store", () => {
  test("writes a meta line once, reads back in order, and reads gzip", async () => {
    const dir = tmp();
    const w = new TickWriter(dir, "test");
    w.write(MES, DAY, { k: "q", t: 1, b: 5700, a: 5700.25, bs: 3, as: 4 });
    w.flush();
    w.write(MES, DAY, { k: "p", t: 2, p: 5700.25, s: 1 });
    w.flush();
    const path = tickPath(dir, "MES", "MESZ6", DAY);
    const recs = [];
    for await (const r of readTickFile(path)) recs.push(r);
    expect(recs.map((r) => r.k)).toEqual(["meta", "q", "p"]);
    expect(recs[0]).toMatchObject({ root: "MES", code: "MESZ6", month: "202612", source: "test" });

    writeFileSync(path + ".gz", Bun.gzipSync(readFileSync(path)));
    rmSync(path);
    const gz = [];
    for await (const r of readTickFile(path + ".gz")) gz.push(r);
    expect(gz).toEqual(recs);
    expect(indexTicks(dir, ["MES"]).map((f) => f.day)).toEqual([DAY]);
  });

  test("merges contracts by time", async () => {
    const dir = tmp();
    const w = new TickWriter(dir, "test");
    const MNQ = frontContract("MNQ", new Date(T0));
    w.write(MES, DAY, { k: "q", t: 10, b: 1, a: 1.25, bs: 1, as: 1 });
    w.write(MES, DAY, { k: "q", t: 30, b: 1, a: 1.25, bs: 1, as: 1 });
    w.write(MNQ, DAY, { k: "q", t: 20, b: 1, a: 1.25, bs: 1, as: 1 });
    w.flush();
    const ts = [];
    for await (const x of mergeStreams(indexTicks(dir, ["MES", "MNQ"]))) ts.push(`${x.root}@${x.rec.t}`);
    expect(ts).toEqual(["MES@10", "MNQ@20", "MES@30"]);
  });
});

describe("historical paging", () => {
  // A fake source: 5 ticks per second for 10 seconds, served 7 at a time from a start time.
  const all = Array.from({ length: 50 }, (_, i) => ({ t: Math.floor(i / 5) * 1000, i }));
  const get = async (at: number) => all.filter((x) => x.t >= at).slice(0, 7);

  test("pages without losing or repeating ticks at page boundaries", async () => {
    const got = await pageTicks(get, 0, 10_000, { pageSize: 7 });
    expect(got.map((x) => x.i)).toEqual(all.map((x) => x.i));
  });

  test("respects the window end", async () => {
    expect((await pageTicks(get, 2000, 4000, { pageSize: 7 })).map((x) => x.t)).toEqual([2000, 2000, 2000, 2000, 2000, 3000, 3000, 3000, 3000, 3000]);
  });

  test("spreads a second's ticks across it in order", () => {
    expect(spreadWithinSecond([{ t: 0 }, { t: 0 }, { t: 0 }, { t: 0 }, { t: 1000 }]).map((x) => x.t)).toEqual([0, 250, 500, 750, 1000]);
  });
});

describe("SimExecution in replay mode", () => {
  const setup = (respectSize = false) => {
    const md = new ManualMarketData();
    let now = 0;
    const ex = new SimExecution(md, { now: () => now, defer: queueMicrotask, latencyMs: 250, respectSize });
    const updates: OrderUpdate[] = [], fills: ExecFill[] = [];
    ex.onOrder((u) => updates.push(u));
    ex.onFill((f) => fills.push(f));
    return { md, ex, updates, fills, at: (t: number) => { now = t; } };
  };
  const flush = () => new Promise<void>((r) => setImmediate(r));

  test("an IOC is matched against the book when it arrives, not when it was sent", async () => {
    const { md, ex, updates, fills, at } = setup();
    md.setQuote(MES, 5700, 5700.25);
    await ex.place({ ref: "a", contract: MES, side: "buy", qty: 1, kind: "limit", price: 5700.25, tif: "ioc" });
    at(100); md.setQuote(MES, 5700.25, 5700.5); // the ask moved away before arrival
    at(250); ex.processDue(250); await flush();
    expect(updates.at(-1)!.state).toBe("cancelled");
    expect(fills).toHaveLength(0);

    await ex.place({ ref: "b", contract: MES, side: "buy", qty: 1, kind: "limit", price: 5700.5, tif: "ioc" });
    at(300); md.setQuote(MES, 5699.75, 5700); // moved our way: fills at the better ask
    at(500); ex.processDue(500); await flush();
    expect(fills.at(-1)).toMatchObject({ ref: "b", price: 5700 });
  });

  test("respectSize fills what the touch shows and cancels the rest of an IOC", async () => {
    const { md, ex, updates, fills, at } = setup(true);
    md.setQuote(MES, 5700, 5700.25, { askSize: 1 });
    await ex.place({ ref: "a", contract: MES, side: "buy", qty: 2, kind: "limit", price: 5700.25, tif: "ioc" });
    at(250); ex.processDue(250); await flush();
    expect(fills.map((f) => f.qty)).toEqual([1]);
    expect(updates.at(-1)).toMatchObject({ state: "cancelled", filled: 1, remaining: 1 });
  });
});

describe("report", () => {
  const fill = (side: "buy" | "sell", qty: number, price: number, ts: number) =>
    ({ root: "MES" as const, position: 0, fill: { ref: "", execId: String(ts), contract: "MESZ6", side, qty, price, ts, commission: 0.5 * qty } });

  test("round trips split a flip and its fees", () => {
    const trips = roundTrips([fill("buy", 1, 100, 1), fill("sell", 2, 101, 2), fill("buy", 1, 100.5, 3)]);
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ side: "long", grossUsd: 5, feesUsd: 1, netUsd: 4 }); // 1 point x $5, fees 0.5 in + 0.5 out
    expect(trips[1]).toMatchObject({ side: "short", entryPrice: 101, exitPrice: 100.5, grossUsd: 2.5, feesUsd: 1, netUsd: 1.5 });
  });

  test("max drawdown", () => {
    const eq = [0, 10, 4, 12, 1, 5].map((usd, ts) => ({ ts, usd }));
    expect(maxDrawdown(eq)).toEqual({ usd: 11, from: 3, to: 4 });
  });
});

describe("replaying logged model answers", () => {
  const dec = (ts: number, up: number) => ({ ts, root: "MES" as const, up, latencyMs: 100 });

  test("reads both log formats, skips late cycles, counts a decision once", async () => {
    const dir = tmp();
    const events = join(dir, "events.jsonl"), decisions = join(dir, "decisions.jsonl");
    writeFileSync(events, [
      { root: "MES", ts: 1000, decision: { probabilities: { buy: 0.8 }, latencyMs: 90, late: false } },
      { root: "MES", ts: 2000, decision: { probabilities: { buy: 0 }, late: true } },
      { root: "MES", ts: 3000, decision: null },
      { root: "MES", ts: 5000, model: "mock", decision: { probabilities: { buy: 0.9 }, late: false } },
    ].map((x) => JSON.stringify(x)).join("\n"));
    writeFileSync(decisions, JSON.stringify({ root: "MES", ts: 1000, probabilities: { buy: 0.8 }, latencyMs: 90, state: {} }) + "\n" +
      JSON.stringify({ root: "MES", ts: 4000, probabilities: { buy: 0.3 }, latencyMs: 80, state: {} }));
    expect(await loadDecisions([events, decisions])).toEqual([dec(1000, 0.8), dec(4000, 0.3)].map((d) => ({ ...d, latencyMs: d.ts === 1000 ? 90 : 80 })));
  });

  test("never looks ahead, and has no answer when the log is stale", async () => {
    let now = 0;
    const m = new LoggedModel([dec(1000, 0.8), dec(31_000, 0.2)], () => now, 60_000);
    const state = { root: "MES" } as never;
    now = 500; await expect(m.decide(state)).rejects.toThrow(); // before the first answer
    now = 30_999; expect((await m.decide(state)).probabilities.buy).toBe(0.8); // not the one at 31 s yet
    now = 31_000; expect((await m.decide(state)).probabilities.buy).toBe(0.2);
    now = 91_001; await expect(m.decide(state)).rejects.toThrow(); // over 60 s old
    expect([m.hits, m.misses]).toEqual([2, 2]);
  });
});

const dec = (ts: number, up: number) => ({ ts, root: "MES" as const, up, latencyMs: 100 });

describe("runBacktest", () => {
  /** MES quotes every second from T0, rising one tick every 10 s, one-tick spread. Optional gap. */
  function trendDay(dir: string, minutes: number, gap?: { fromMin: number; toMin: number }) {
    const w = new TickWriter(dir, "test");
    for (let s = 0; s < minutes * 60; s++) {
      if (gap && s >= gap.fromMin * 60 && s < gap.toMin * 60) continue;
      const bid = 5700 + Math.floor(s / 10) * 0.25;
      w.write(MES, DAY, { k: "q", t: T0 + s * 1000, b: bid, a: bid + 0.25, bs: 5, as: 5 });
    }
    w.flush();
  }

  test("exact PnL on a known path, and what latency costs", async () => {
    const dir = tmp();
    trendDay(dir, 30);
    // Cycles run at T0 + 60 s, 90 s, ... which is exactly when the price steps up, before that quote is applied:
    // the book the decision sees has bid 5701.25 / ask 5701.50, and from T0 + 60 s the ask is 5701.75.
    const lastBid = 5700 + Math.floor((30 * 60 - 1) / 10) * 0.25;

    const instant = await runBacktest(base(dir, { latencyMs: 0 }));
    expect(instant.fills[0]!.fill).toMatchObject({ side: "buy", qty: 1, price: 5701.5, ts: T0 + 60_000 });
    const si = summarize(instant);
    expect(si.openUsd).toBeCloseTo((lastBid - 5701.5) * 5, 6);
    expect(si.netUsd).toBeCloseTo((lastBid - 5701.5) * 5 - 0.62, 2);
    expect(si.trips).toBe(0); // still open
    expect(si.perRoot[0]!.exposure).toBe(1);

    // 250 ms later the ask has moved: an IOC at the old ask misses, every cycle.
    const late = await runBacktest(base(dir));
    expect(late.fills).toHaveLength(0);
    expect(summarize(late).perRoot[0]!.orders).toBeGreaterThan(50);

    // One tick of slippage allowance catches it.
    const slipped = await runBacktest(base(dir, { cfg: { ...cfg, slipTicks: 1 } }));
    expect(slipped.fills[0]!.fill).toMatchObject({ price: 5701.75, ts: T0 + 60_250 });
  });

  test("replays logged answers through the full loop", async () => {
    const dir = tmp();
    trendDay(dir, 30);
    // Logged answers every 30 s: bullish for 10 minutes, then bearish.
    const logged = Array.from({ length: 58 }, (_, i) => dec(T0 + 60_000 + i * 30_000, i < 20 ? 0.9 : 0.1));
    let model: LoggedModel | null = null;
    const r = await runBacktest({ ...base(dir, { latencyMs: 0 }), model: undefined, modelFactory: (clock) => (model = new LoggedModel(logged, clock)) });
    const fills = r.fills.map((f) => f.fill.side);
    expect(fills[0]).toBe("buy");
    expect(fills).toContain("sell");
    expect(model!.hits).toBeGreaterThan(50);
    expect(r.options.model).toBe("replay");
  });

  test("cycles are skipped while the data is stale", async () => {
    const dir = tmp();
    trendDay(dir, 30, { fromMin: 10, toMin: 20 });
    const r = await runBacktest(base(dir, { model: new ConstModel(0.5) }));
    // Last quote before the gap at 599 s; stale after 719 s. Cycles at 720, 750, ..., 1200 s (the one at 1200 runs
    // before that second's quote is applied): 17.
    expect(r.skipped.MESZ6).toBe(17);
  });

  test("synthetic runs are deterministic", async () => {
    const dir = tmp();
    generateSynthetic({ dir, root: "MES", from: DAY, days: 1, hours: 2, seed: 7 });
    const { FuturesMockModel } = await import("../model");
    const run = async () => summarize(await runBacktest(base(dir, { model: new FuturesMockModel(), warmupMinutes: 15 })));
    const [a, b] = [await run(), await run()];
    expect(a.trips).toBeGreaterThan(0);
    expect({ ...a, run: null }).toEqual({ ...b, run: null });
    // Every dollar is accounted for: closed trips, plus the open position less its entry fees, equal the total.
    const r = await runBacktest(base(dir, { model: new FuturesMockModel(), warmupMinutes: 15 }));
    const closed = roundTrips(r.fills).reduce((x, t) => x + t.netUsd, 0);
    const openQty = Math.abs(r.events.at(-1)!.position.qty);
    expect(closed + a.openUsd - openQty * 0.62).toBeCloseTo(a.netUsd, 1);
  });
});
