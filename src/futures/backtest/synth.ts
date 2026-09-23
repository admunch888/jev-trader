import { frontContract, fromTicks, SPECS, toTicks } from "../contracts";
import type { Root } from "../types";
import { TickWriter } from "./format";

export interface SynthOptions {
  dir: string;
  root: Root;
  /** First trading day to generate, YYYY-MM-DD; weekends are skipped. */
  from: string;
  days: number;
  /** Starting price. Defaults per root. */
  price?: number;
  seed?: number;
  /** Hours of each session to generate, starting at the 08:30 Chicago cash open. Default the whole 23 hour Globex day. */
  hours?: number;
  /** Mean seconds between quote changes. */
  quoteEverySeconds?: number;
  /** Autocorrelation of moves, -1..1: above 0 trends, below 0 mean-reverts. */
  momentum?: number;
  /** Standard deviation of a full session's move, in ticks. Defaults are roughly typical: MES 200, MNQ 900, ZB 32. */
  dailyTicks?: number;
}

const DEFAULT_PRICE: Record<Root, number> = { MES: 5700, MNQ: 20_000, ZB: 117.5 };
const DEFAULT_DAILY_TICKS: Record<Root, number> = { MES: 200, MNQ: 900, ZB: 32 };

/**
 * Seeded random-walk quotes and prints in the tick store format, for trying the backtester without IBKR data
 * and for tests. Moves are one tick with a little momentum, the spread is usually one tick and sometimes two,
 * and prints land at the bid or ask. It is not market data and says nothing about a strategy's real edge.
 */
export function generateSynthetic(o: SynthOptions) {
  const spec = SPECS[o.root];
  const rnd = mulberry32(o.seed ?? 1);
  const w = new TickWriter(o.dir, "synthetic");
  const every = (o.quoteEverySeconds ?? 1) * 1000;
  const momentum = o.momentum ?? 0.15;
  // A +-step walk with move probability p has variance p * step^2 per quote; size it to the daily target.
  const quotesPerDay = ((o.hours ?? 23) * 3_600_000) / every;
  const perQuote = (o.dailyTicks ?? DEFAULT_DAILY_TICKS[o.root]) ** 2 / quotesPerDay;
  const stepTicks = Math.max(1, Math.round(Math.sqrt(perQuote)));
  const pMove = Math.min(1, perQuote / stepTicks ** 2);
  let mid = toTicks(spec, o.price ?? DEFAULT_PRICE[o.root]);
  let lastMove = 0;
  let written = 0;
  let day = new Date(`${o.from}T12:00:00Z`);
  for (let n = 0; n < o.days;) {
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) { day = new Date(day.getTime() + 86_400_000); continue; }
    const date = day.toISOString().slice(0, 10);
    const contract = frontContract(o.root, day);
    // Globex day: 17:00 Chicago the evening before to 16:00. Chicago is UTC-5 in summer, UTC-6 in winter.
    const offsetH = chicagoOffsetHours(day);
    const sessionStart = Date.parse(`${date}T00:00:00Z`) - 7 * 3_600_000 + offsetH * 3_600_000;
    const start = o.hours ? Date.parse(`${date}T08:30:00Z`) + offsetH * 3_600_000 : sessionStart;
    const end = o.hours ? start + o.hours * 3_600_000 : sessionStart + 23 * 3_600_000;
    for (let t = start; t < end; t += Math.max(1, Math.round(-Math.log(1 - rnd()) * every))) {
      const move = rnd() >= pMove ? 0 : (rnd() < 0.5 + momentum * lastMove * 0.5 ? 1 : -1);
      if (move) { mid += move * stepTicks; lastMove = move; }
      const spread = rnd() < 0.9 ? 1 : 2;
      const bid = mid - Math.floor(spread / 2), ask = bid + spread;
      w.write(contract, date, { k: "q", t, b: fromTicks(spec, bid), a: fromTicks(spec, ask), bs: 1 + Math.floor(rnd() * 40), as: 1 + Math.floor(rnd() * 40) });
      written++;
      if (rnd() < 0.3) {
        const buy = move ? move > 0 : rnd() < 0.5;
        w.write(contract, date, { k: "p", t: t + 1, p: fromTicks(spec, buy ? ask : bid), s: 1 + Math.floor(rnd() * 5) });
        written++;
      }
    }
    w.flush();
    n++;
    day = new Date(day.getTime() + 86_400_000);
  }
  return written;
}

/** 5 during US daylight saving (second Sunday of March to first Sunday of November), else 6. */
function chicagoOffsetHours(d: Date) {
  const y = d.getUTCFullYear();
  const nthSunday = (m: number, n: number) => { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return Date.UTC(y, m, 1 + ((7 - first) % 7) + 7 * (n - 1)); };
  return d.getTime() >= nthSunday(2, 2) && d.getTime() < nthSunday(10, 1) ? 5 : 6;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
