import { describe, expect, test } from "bun:test";
import { clampTarget, RiskGuard, shapeTarget, smoothed, targetFromProbability, type Gates } from "./policy";

const P = { enterProb: 0.6, flatBand: 0.05, qty: 1 };
const open: Gates = { brokerDown: false, halted: false, roll: false, weekend: false, stopBreached: false, closed: false, noNewRisk: [], maxContracts: 2 };

describe("targetFromProbability", () => {
  test("long, short, flat, keep", () => {
    expect(targetFromProbability(0.7, 0, P)).toBe(1);
    expect(targetFromProbability(0.3, 1, P)).toBe(-1);
    expect(targetFromProbability(0.52, 1, P)).toBe(0);
    expect(targetFromProbability(0.57, -1, P)).toBe(-1); // between band and enter: keep
    expect(targetFromProbability(0.43, 1, P)).toBe(1);
  });
});

describe("clampTarget", () => {
  test("flatten gates win over the model", () => {
    for (const g of ["halted", "roll", "weekend", "stopBreached"] as const) {
      expect(clampTarget(1, 1, { ...open, [g]: true }).target).toBe(0);
    }
  });

  test("broker down holds whatever the other gates say", () => {
    expect(clampTarget(0, 1, { ...open, brokerDown: true, halted: true })).toEqual({ target: 1, gate: "broker" });
  });

  test("closed session leaves the position alone", () => {
    expect(clampTarget(-1, 1, { ...open, closed: true })).toEqual({ target: 1, gate: "closed" });
  });

  test("no new risk: exits allowed, adds and flips cut back", () => {
    const g = { ...open, noNewRisk: ["spread 3 ticks"] };
    expect(clampTarget(1, 0, g).target).toBe(0); // open
    expect(clampTarget(-1, 1, g).target).toBe(0); // flip becomes exit
    expect(clampTarget(2, 1, g).target).toBe(1); // add refused
    expect(clampTarget(0, 1, g)).toEqual({ target: 0, gate: null }); // plain exit is not gated
  });

  test("max contracts", () => {
    expect(clampTarget(-3, 0, open)).toEqual({ target: -2, gate: "max-contracts" });
  });
});

describe("anti-churn shaping", () => {
  test("average of the last n readings, none until there are n", () => {
    expect(smoothed([0.9], 2)).toBeNull();
    expect(smoothed([0.2, 0.9, 0.5], 2)).toBeCloseTo(0.7, 9);
    expect(smoothed([0.8], 1)).toBe(0.8);
  });

  const o = { allowFlip: false, heldMs: 10 * 60_000, minHoldMs: 5 * 60_000 };
  test("no flips: the other side goes flat first", () => {
    expect(shapeTarget(-1, 1, o)).toEqual({ target: 0, shape: "no-flip" });
    expect(shapeTarget(-1, 1, { ...o, allowFlip: true })).toEqual({ target: -1, shape: null });
    expect(shapeTarget(-1, 0, o)).toEqual({ target: -1, shape: null }); // from flat is an entry, not a flip
  });

  test("min hold keeps a young position, but lets it be added to", () => {
    const young = { ...o, heldMs: 60_000 };
    expect(shapeTarget(0, 1, young)).toEqual({ target: 1, shape: "min-hold" });
    expect(shapeTarget(-1, 1, young)).toEqual({ target: 1, shape: "min-hold" });
    expect(shapeTarget(2, 1, young)).toEqual({ target: 2, shape: null });
    expect(shapeTarget(0, 1, o)).toEqual({ target: 0, shape: null }); // held long enough
  });
});

describe("RiskGuard", () => {
  test("halts on the summed daily loss and resets on a new trading day", () => {
    const g = new RiskGuard(100);
    g.report("MES", "2026-09-22", -60);
    expect(g.halted).toBeNull();
    g.report("ZB", "2026-09-22", -45);
    expect(g.halted).toContain("$105.00");
    g.report("MES", "2026-09-22", 0); // recovering does not un-halt
    expect(g.halted).not.toBeNull();
    g.report("MES", "2026-09-23", 0);
    expect(g.halted).toBeNull();
  });
});
