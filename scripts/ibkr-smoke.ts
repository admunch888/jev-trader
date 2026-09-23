/**
 * Read-only check of the IBKR adapters against a running TWS / IB Gateway (paper by default).
 * Resolves MES, MNQ and ZB, prints a book snapshot and bar count for each, the account summary and positions,
 * and a what-if margin check for one contract. Places no orders: whatIf is never routed.
 *
 *   IB_PORT=4002 bun run scripts/ibkr-smoke.ts
 */
import { formatPrice, IbkrExecution, IbkrMarketData, SPECS, type Root } from "../src/futures";

const ROOTS: Root[] = ["MES", "MNQ", "ZB"];
const md = new IbkrMarketData();
const ex = new IbkrExecution();

await md.connect();
await ex.connect();
console.log("connected");

for (const root of ROOTS) {
  const spec = SPECS[root];
  const c = await md.resolve(root);
  await md.subscribe(c);
  await Bun.sleep(3000);
  const b = md.book(c);
  const bars = await md.bars(c, "1m", "3600 S");
  const cal = c.calendar;
  console.log(
    `${c.code} conId ${c.brokerId} | last trade ${cal.lastTradeDate.toISOString().slice(0, 10)} roll ${cal.rollDate.toISOString().slice(0, 10)}` +
    (cal.firstNoticeDate ? ` FND ${cal.firstNoticeDate.toISOString().slice(0, 10)}` : "") +
    ` | open ${spec.session.isOpen(new Date())}`,
  );
  console.log(b
    ? `  ${formatPrice(spec, b.bid)} x ${formatPrice(spec, b.ask)} (${b.bidSize} x ${b.askSize}) spread ${b.spreadTicks} ticks${b.delayed ? " DELAYED" : ""}`
    : "  no quote (market closed or no data subscription)");
  console.log(`  ${bars.length} one-minute bars in the last hour`);
  if (b) {
    const wi = await ex.whatIf({ ref: `smoke-${root}`, contract: c, side: "buy", qty: 1, kind: "limit", price: b.bid - 20 * spec.tickSize, tif: "day" });
    console.log(`  whatIf 1 lot: init margin +$${wi.initMarginChange.toFixed(2)} maint +$${wi.maintMarginChange.toFixed(2)} commission ${wi.commission ?? "n/a"}`);
  }
}

console.log("account", await ex.account());
console.log("positions", await ex.positions());
await md.close();
await ex.close();
process.exit(0);
