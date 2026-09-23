/**
 * bun run fetch-ticks --root MES --from 2026-09-22T13:30:00Z --to 2026-09-22T20:00:00Z [--month 202612] [--data data/ticks] [--pace 10.5]
 *
 * Downloads IBKR historical bid/ask and trade ticks into the tick store, so a backtest can start without days of
 * recording. Only practical for short windows: IBKR returns at most 1000 ticks per request, allows roughly 60
 * historical requests per 10 minutes (hence `--pace` seconds between requests), and a busy hour of MES can be tens
 * of thousands of quote changes. It also serves only the current and recent contracts, not long-expired ones.
 *
 * IBKR stamps historical ticks to the whole second. Ticks sharing a second are spread evenly across it, in order,
 * so replay keeps their sequence. Existing files are appended to; do not fetch the same window twice.
 */
import { parseArgs } from "node:util";
import { contractFor, SPECS } from "../contracts";
import { IbkrMarketData } from "../ibkr/marketData";
import type { FuturesContract, Root } from "../types";
import { pageTicks, spreadWithinSecond, TickWriter, type TickRecord } from "./format";

const { values: a } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    root: { type: "string" },
    month: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    data: { type: "string", default: "data/ticks" },
    pace: { type: "string", default: "10.5" },
    "chunk-min": { type: "string", default: "60" },
  },
});
const root = a.root?.toUpperCase() as Root;
if (!root || !(root in SPECS) || !a.from || !a.to) throw new Error("usage: bun run fetch-ticks --root MES --from <ISO> --to <ISO> [--month YYYYMM]");
const from = Date.parse(a.from), to = Date.parse(a.to);
if (!(from < to)) throw new Error("--from must be before --to");
const paceMs = Number(a.pace) * 1000;

const md = new IbkrMarketData();
await md.connect();
const contract: FuturesContract = a.month
  ? contractFor(root, Number(a.month.slice(0, 4)), Number(a.month.slice(4, 6)))
  : await md.resolve(root, new Date(from));
const writer = new TickWriter(a.data!, "ibkr-historical");
let requests = 0;
const page = <T extends { t: number }>(what: string, get: (at: number) => Promise<T[]>, s: number, e: number) =>
  pageTicks(get, s, e, {
    pause: async () => { requests++; await Bun.sleep(paceMs); },
    onError: (at, err) => console.warn(`  ${what} from ${new Date(at).toISOString()}: ${err.message}`),
  });

console.log(`fetching ${contract.code} ${new Date(from).toISOString()} to ${new Date(to).toISOString()} into ${a.data}, ${a.pace}s between requests`);
const chunk = Number(a["chunk-min"]) * 60_000;
let total = 0;
for (let s = from; s < to; s += chunk) {
  const e = Math.min(to, s + chunk);
  if (!SPECS[root].session.isOpen(new Date(s)) && !SPECS[root].session.isOpen(new Date(e - 1))) continue;
  const quotes = spreadWithinSecond(await page("quotes", (at) => md.historicalQuotes(contract, at), s, e)).map((q): TickRecord => ({ k: "q", ...q }));
  const trades = spreadWithinSecond(await page("trades", (at) => md.historicalTrades(contract, at), s, e)).map((p): TickRecord => ({ k: "p", ...p }));
  const merged = [...quotes, ...trades].sort((x, y) => x.t - y.t || (x.k === y.k ? 0 : x.k === "q" ? -1 : 1));
  for (const r of merged) writer.write(contract, SPECS[root].session.tradingDay(new Date(r.t)), r);
  writer.flush();
  total += merged.length;
  console.log(`  ${new Date(s).toISOString().slice(0, 16)}: ${quotes.length} quotes, ${trades.length} trades (${requests} requests so far)`);
}
console.log(`done: ${total} records for ${contract.code}`);
await md.close();
process.exit(0);
