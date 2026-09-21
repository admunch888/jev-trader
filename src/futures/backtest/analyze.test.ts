import { describe, expect, test } from "bun:test";
import { corr, scoreCalls, type Call, type Series } from "./analyze";

// A price path in ticks of 1: up to minute 20, down to minute 40, then up again.
const t0 = 1_000_000;
const path = (fn: (min: number) => number): Series => {
  const t: number[] = [], mid: number[] = [];
  for (let s = 0; s <= 60 * 60; s += 10) { t.push(t0 + s * 1000); mid.push(fn(s / 60)); }
  return { t, mid };
};
const mids = new Map([["MESZ6", path((m) => (m < 20 ? m : m < 40 ? 40 - m : m - 40))]]);
const call = (min: number, up: number): Call => ({ ts: t0 + min * 60_000, contract: "MESZ6", up, costTicks: 2 });

describe("scoreCalls", () => {
  test("a chasing model: agrees with the past, wrong about the next 5 minutes", () => {
    // Bullish at the top, right after the rise; bearish at the bottom, right after the fall.
    const calls = [20, 21, 22].map((m) => call(m, 0.8)).concat([40, 41, 42].map((m) => call(m, 0.2)));
    const s = scoreCalls(calls, mids, 1);
    expect(s.corrPast5!).toBeGreaterThan(0.5);
    expect(s.corrNext5!).toBeLessThan(0);
    expect(s.capturedStrong5!).toBeLessThan(0);
    expect(s.avgCostTicks).toBe(2);
  });

  test("a predictive model: right about the next 5 minutes", () => {
    const calls = [5, 6, 7, 8, 9, 10].map((m) => call(m, 0.8)).concat([25, 26, 27, 28, 29, 30].map((m) => call(m, 0.2)));
    const s = scoreCalls(calls, mids, 1);
    expect(s.hit5).toBe(1);
    expect(s.corrNext5!).toBeGreaterThan(0.9);
    expect(s.capturedStrong5).toBe(5); // 1 tick a minute for 5 minutes
  });

  test("calls without 5 minutes of prices after them are left out", () => {
    expect(scoreCalls([call(58, 0.8)], mids, 1).calls).toBe(0);
  });

  test("corr", () => {
    expect(corr([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 9);
    expect(corr([1, 2], [1, 2])).toBeNull();
  });
});
