import { beforeEach, describe, expect, test } from "bun:test";
import type { Decision, Model } from "../model";
import { futuresConfig, type FuturesConfig } from "./config";
import type { FuturesTradeState } from "./model";
import { RiskGuard } from "./policy";
import { ManualMarketData, SimExecution } from "./sim";
import { FuturesTrader, type FuturesEvent } from "./trader";
import type { FuturesContract } from "./types";

/** Answers whatever probability of "up" the test sets. `hang` never answers. */
class ScriptedModel implements Model<FuturesTradeState> {
  readonly name = "mock";
  p = 0.5;
  hang = false;
  delayMs = 0;
  last: FuturesTradeState | null = null;
  async decide(s: FuturesTradeState): Promise<Decision> {
    this.last = s;
    if (this.hang) return new Promise(() => {});
    if (this.delayMs) await Bun.sleep(this.delayMs);
    return { action: this.p >= 0.5 ? "buy" : "sell", probabilities: { buy: this.p, sell: 1 - this.p, hold: 0 }, upIn10: this.p, latencyMs: 1, inputTokens: 0 };
  }
}

const TUE_0900_CDT = new Date("2026-09-22T14:00:00Z");
const baseCfg: FuturesConfig = {
  ...futuresConfig, roots: ["MES"], exec: "sim", decisionSeconds: 30, horizonMinutes: 5, modelTimeoutMs: 50,
  qty: 1, maxContracts: 1, enterProb: 0.6, flatBand: 0.05, slipTicks: 0, maxSpreadTicks: 2, stopTicks: () => 16,
  dailyLossUsd: 1_000, entryCutoffMinutes: 10, flattenBeforeWeekendMinutes: 15, reconcileEveryCycles: 1_000, orderTimeoutMs: 30_000, depthRows: 0,
};

let md: ManualMarketData, ex: SimExecution, model: ScriptedModel, trader: FuturesTrader, c: FuturesContract;
let clock: Date;
let events: FuturesEvent[];

async function setup(cfg: Partial<FuturesConfig> = {}) {
  md = new ManualMarketData();
  ex = new SimExecution(md);
  model = new ScriptedModel();
  clock = TUE_0900_CDT;
  events = [];
  const full = { ...baseCfg, ...cfg };
  trader = new FuturesTrader({ root: "MES", md, ex, model, guard: new RiskGuard(full.dailyLossUsd), cfg: full, liveOrders: false, now: () => clock, onEvent: (e) => events.push(e), log: () => {} });
  await trader.start();
  c = trader.contract;
  md.setQuote(c, 5700, 5700.25);
}

/** Let the simulated broker's async status and fill messages land. */
const settle = () => Bun.sleep(5);
/** Run one cycle at probability `p` and let everything settle. Returns that cycle's event. */
async function cycleAt(p: number) {
  model.p = p;
  await trader.cycle();
  await settle();
  await settle();
  return events.at(-1)!;
}

describe("FuturesTrader", () => {
  beforeEach(() => setup());

  test("goes long on a confident buy and protects it with one stop", async () => {
    const e = await cycleAt(0.8);
    expect(e.order).toMatchObject({ side: "buy", qty: 1, price: 5700.25 });
    expect(trader.position).toEqual({ qty: 1, avgPrice: 5700.25 });
    const keep = await cycleAt(0.58);
    expect(keep.order).toBeNull();
    expect(keep.stop).toEqual({ price: 5696.25, qty: 1, state: "working" }); // 16 ticks below entry
    expect(keep.totals.orders).toBe(2); // entry + stop, no duplicate stop
  });

  test("the model sees the contract, cost and position", async () => {
    await cycleAt(0.8);
    await cycleAt(0.58);
    const s = model.last!;
    expect(s.contract).toBe("MESZ6");
    expect(s.spreadTicks).toBe(1);
    expect(s.costTicks).toBeCloseTo(1 + (2 * 0.62) / 1.25, 2);
    expect(s.position).toMatchObject({ side: "long", contracts: 1, entry: 5700.25 });
    expect(s.allowed).toEqual({ buy: false, sell: true }); // already at max contracts long
  });

  test("flips short in one order and moves the stop to the other side", async () => {
    await cycleAt(0.8);
    const flip = await cycleAt(0.2);
    expect(flip.order).toMatchObject({ side: "sell", qty: 2, price: 5700 });
    await settle();
    expect(trader.position).toEqual({ qty: -1, avgPrice: 5700 });
    const keep = await cycleAt(0.42);
    expect(keep.stop).toEqual({ price: 5704, qty: 1, state: "working" });
    expect(keep.totals.realizedUsd).toBe(-1.25); // bought 5700.25, sold 5700, $5 a point
  });

  test("goes flat near 50/50 and pulls the stop", async () => {
    await cycleAt(0.8);
    await cycleAt(0.58);
    const flat = await cycleAt(0.5);
    expect(flat.order).toMatchObject({ side: "sell", qty: 1 });
    const after = await cycleAt(0.5);
    expect(trader.position.qty).toBe(0);
    expect(after.stop).toBeNull();
  });

  test("the protective stop fills when the market runs through it", async () => {
    await cycleAt(0.8);
    await cycleAt(0.58);
    md.setQuote(c, 5695, 5695.25);
    await settle();
    expect(trader.position.qty).toBe(0);
    const e = await cycleAt(0.58);
    expect(e.order).toBeNull();
    expect(e.totals.realizedUsd).toBe(-26.25); // 5700.25 -> 5695, $5 a point
    expect(e.totals.feesUsd).toBeCloseTo(1.24, 9);
  });

  test("wide spread blocks new risk but not exits", async () => {
    md.setQuote(c, 5700, 5700.75);
    const blocked = await cycleAt(0.9);
    expect(blocked.order).toBeNull();
    expect(blocked.gate).toBe("no-new-risk");
    md.setQuote(c, 5700, 5700.25);
    await cycleAt(0.9);
    md.setQuote(c, 5700, 5700.75);
    const exit = await cycleAt(0.1); // wants to flip short, only the exit goes
    expect(exit.order).toMatchObject({ side: "sell", qty: 1 });
    expect(exit.target).toBe(0);
  });

  test("session closed: the model is not asked and nothing is sent", async () => {
    clock = new Date("2026-09-26T15:00:00Z"); // Saturday
    const e = await cycleAt(0.9);
    expect(e.gate).toBe("closed");
    expect(e.decision).toBeNull();
    expect(e.order).toBeNull();
  });

  test("flattens ahead of the weekend close", async () => {
    await cycleAt(0.9);
    clock = new Date("2026-09-25T20:50:00Z"); // Fri 15:50 CDT, 10 min to the weekend close
    const e = await cycleAt(0.9);
    expect(e.gate).toBe("weekend");
    expect(e.order).toMatchObject({ side: "sell", qty: 1 });
  });

  test("model timeout holds the position", async () => {
    model.hang = true;
    const e = await cycleAt(0.9);
    expect(e.decision).toBeNull();
    expect(e.order).toBeNull();
    expect(e.totals.timeouts).toBe(1);
    expect(e.notes.join()).toContain("no answer in time");
  });

  test("a cycle that comes due while the last is running is late", async () => {
    model.delayMs = 30;
    model.p = 0.5;
    const first = trader.cycle();
    await trader.cycle();
    await first;
    expect(events.some((e) => e.decision?.late)).toBe(true);
    expect(events.at(-1)!.totals.late).toBe(1);
  });

  test("rolls to the next contract, flattening first", async () => {
    await cycleAt(0.9);
    clock = new Date("2026-12-10T15:00:00Z"); // MESZ6 roll date
    const flatten = await cycleAt(0.9);
    expect(flatten.gate).toBe("roll");
    expect(flatten.order).toMatchObject({ side: "sell", qty: 1 });
    const rolled = await cycleAt(0.9);
    expect(trader.contract.code).toBe("MESH7");
    expect(rolled.notes).toContain("rolled MESZ6 -> MESH7");
  });

  test("daily loss limit flattens and stays flat", async () => {
    await setup({ dailyLossUsd: 20, stopTicks: () => 100 });
    await cycleAt(0.9);
    md.setQuote(c, 5695, 5695.25); // -26.25 unrealized
    const hit = await cycleAt(0.9);
    expect(hit.halted).toContain("daily loss");
    expect(hit.order).toMatchObject({ side: "sell", qty: 1 });
    const after = await cycleAt(0.95);
    expect(after.order).toBeNull();
    expect(trader.position.qty).toBe(0);
  });

  test("applies fills on the traded contract that did not come from this loop", async () => {
    await cycleAt(0.9);
    await ex.place({ ref: "manual-1", contract: c, side: "buy", qty: 1, kind: "market", tif: "day" }); // someone else trades the account
    await settle();
    expect(trader.position.qty).toBe(2);
  });

  test("adopts the broker's position at startup", async () => {
    await ex.place({ ref: "before-restart", contract: c, side: "sell", qty: 1, kind: "market", tif: "day" });
    await settle();
    const restarted = new FuturesTrader({ root: "MES", md, ex, model, guard: new RiskGuard(1_000), cfg: baseCfg, liveOrders: false, now: () => clock, log: () => {} });
    await restarted.start();
    expect(restarted.position).toEqual({ qty: -1, avgPrice: 5700 });
  });
});
