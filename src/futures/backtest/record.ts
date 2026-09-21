/**
 * bun run record [--data data/ticks]
 *
 * Records live IBKR quotes and prints for FUT_ROOTS into the tick store, one file per contract per trading day,
 * for replay with `bun run backtest`. Records the front contract, and also the next one from 10 days before the
 * roll so a backtest can roll across. Leave it running (IB Gateway restarts nightly; IbkrMarketData reconnects).
 *
 * This is what the live trader sees: IBKR samples top of book a few times a second rather than every change, and
 * prints come from tick-by-tick trades. Both are stamped with the time they arrived here.
 */
import { parseArgs } from "node:util";
import { futuresConfig } from "../config";
import { addDays, contractFor, frontContract, SPECS } from "../contracts";
import { IbkrMarketData } from "../ibkr/marketData";
import type { FuturesContract, Root } from "../types";
import { TickWriter } from "./format";

const { values: a } = parseArgs({ args: Bun.argv.slice(2), options: { data: { type: "string", default: "data/ticks" } } });
const md = new IbkrMarketData();
await md.connect();
const writer = new TickWriter(a.data!, "ibkr-live");
const watching = new Map<string, FuturesContract>();
const lastQuote = new Map<string, string>();
const counts = new Map<string, { q: number; p: number }>();
let warnedDelayed = false;

async function watch(root: Root, c: FuturesContract) {
  if (watching.has(c.code)) return;
  const resolved = c; // the front comes resolved (conId); the next contract goes by symbol and month
  watching.set(c.code, resolved);
  counts.set(c.code, { q: 0, p: 0 });
  await md.subscribe(resolved);
  md.onBook(resolved, (b) => {
    if (b.delayed) {
      if (!warnedDelayed) console.warn("delayed data: not recording it. Set IB_MARKET_DATA_TYPE=1 with a real-time subscription.");
      warnedDelayed = true;
      return;
    }
    const key = `${b.bid} ${b.ask} ${b.bidSize} ${b.askSize}`;
    if (lastQuote.get(c.code) === key) return;
    lastQuote.set(c.code, key);
    const t = Date.now();
    writer.write(resolved, SPECS[root].session.tradingDay(new Date(t)), { k: "q", t, b: b.bid, a: b.ask, bs: b.bidSize, as: b.askSize });
    counts.get(c.code)!.q++;
  });
  md.onPrint(resolved, (p) => {
    const t = Date.now();
    writer.write(resolved, SPECS[root].session.tradingDay(new Date(t)), { k: "p", t, p: p.price, s: p.size });
    counts.get(c.code)!.p++;
  });
  console.log(`recording ${c.code}${c.brokerId ? ` (conId ${c.brokerId})` : ""} into ${a.data}/${root}/${c.code}/`);
}

/** Front contract, plus the next listed one once the front is within 10 days of its roll. */
async function refresh() {
  const now = new Date();
  for (const root of futuresConfig.roots) {
    const front = await md.resolve(root, now);
    await watch(root, front);
    if (now >= addDays(front.calendar.rollDate, -10)) {
      const next = frontContract(root, addDays(front.calendar.rollDate, 1));
      if (next.code !== front.code) {
        const y = Number(next.month.slice(0, 4)), m = Number(next.month.slice(4, 6));
        await watch(root, { ...contractFor(root, y, m), code: next.code });
      }
    }
  }
}

await refresh();
setInterval(() => writer.flush(), 1000);
setInterval(() => void refresh().catch((e) => console.warn(`refresh failed: ${(e as Error).message}`)), 10 * 60_000);
setInterval(() => {
  console.log(`${new Date().toISOString()} ${[...counts].map(([code, c]) => `${code} ${c.q} quotes ${c.p} prints`).join(" | ")} (feed ${md.status})`);
}, 60_000);

const stop = async () => { writer.flush(); await md.close(); process.exit(0); };
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
