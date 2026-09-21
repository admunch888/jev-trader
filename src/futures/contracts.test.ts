import { describe, expect, test } from "bun:test";
import { contractFor, formatPrice, frontContract, onTick, parsePrice, pnlUsd, roundToTick, SPECS, thirdFriday } from "./contracts";

const day = (d: Date | null) => d?.toISOString().slice(0, 10);

describe("calendars", () => {
  test("equity index: third Friday expiry, roll 8 days earlier", () => {
    expect(day(thirdFriday(2026, 9))).toBe("2026-09-18");
    const c = contractFor("MES", 2026, 12);
    expect(c.code).toBe("MESZ6");
    expect(c.month).toBe("202612");
    expect(day(c.calendar.lastTradeDate)).toBe("2026-12-18");
    expect(day(c.calendar.rollDate)).toBe("2026-12-10");
    expect(c.calendar.firstNoticeDate).toBeNull();
  });

  test("ZB: first notice is the last business day of the prior month, roll ahead of it", () => {
    const c = contractFor("ZB", 2026, 12);
    expect(day(c.calendar.firstNoticeDate)).toBe("2026-11-30");
    expect(day(c.calendar.rollDate)).toBe("2026-11-25");
    // Weekends only: the exchange date is a day earlier because of Christmas. IbkrMarketData.resolve overwrites it with IBKR's.
    expect(day(c.calendar.lastTradeDate)).toBe("2026-12-22");
  });

  test("ZB March: first notice falls back from a weekend month end", () => {
    // Feb 28 2027 is a Sunday
    expect(day(contractFor("ZB", 2027, 3).calendar.firstNoticeDate)).toBe("2027-02-26");
  });

  test("front contract skips expiries past their roll date", () => {
    expect(frontContract("MNQ", new Date("2026-09-09T15:00:00Z")).code).toBe("MNQU6");
    expect(frontContract("MNQ", new Date("2026-09-10T15:00:00Z")).code).toBe("MNQZ6");
    expect(frontContract("ZB", new Date("2026-09-21T15:00:00Z")).code).toBe("ZBZ6");
    expect(frontContract("ZB", new Date("2026-11-25T15:00:00Z")).code).toBe("ZBH7");
    expect(frontContract("MES", new Date("2026-12-31T15:00:00Z")).code).toBe("MESH7");
  });

  test("non-cycle months are rejected", () => {
    expect(() => contractFor("MES", 2026, 10)).toThrow();
  });
});

describe("session", () => {
  const open = (iso: string) => SPECS.MES.session.isOpen(new Date(iso));
  test("Globex hours in Chicago time", () => {
    expect(open("2026-09-20T21:59:00Z")).toBe(false); // Sun 16:59 CDT
    expect(open("2026-09-20T22:00:00Z")).toBe(true); // Sun 17:00 CDT open
    expect(open("2026-09-22T20:30:00Z")).toBe(true); // Tue 15:30 CDT
    expect(open("2026-09-22T21:30:00Z")).toBe(false); // Tue 16:30 CDT maintenance break
    expect(open("2026-09-25T20:59:00Z")).toBe(true); // Fri 15:59 CDT
    expect(open("2026-09-25T21:00:00Z")).toBe(false); // Fri 16:00 CDT close
    expect(open("2026-09-26T15:00:00Z")).toBe(false); // Saturday
    expect(open("2026-12-01T22:30:00Z")).toBe(false); // Tue 16:30 CST break (winter offset)
    expect(open("2026-12-01T23:00:00Z")).toBe(true); // Tue 17:00 CST reopen
  });
});

describe("tick math", () => {
  test("grid", () => {
    expect(roundToTick(SPECS.MES, 5712.3)).toBe(5712.25);
    expect(onTick(SPECS.MNQ, 20001.5)).toBe(true);
    expect(onTick(SPECS.MNQ, 20001.1)).toBe(false);
    expect(onTick(SPECS.ZB, 117 + 17 / 32)).toBe(true);
    expect(onTick(SPECS.ZB, 117.51)).toBe(false);
  });

  test("ZB quotes in 32nds", () => {
    expect(formatPrice(SPECS.ZB, 117.5)).toBe("117'16");
    expect(formatPrice(SPECS.ZB, 117 + 1 / 32)).toBe("117'01");
    expect(parsePrice(SPECS.ZB, "117'16")).toBe(117.5);
    expect(formatPrice(SPECS.MES, 5712.25)).toBe("5712.25");
  });

  test("tick value and PnL", () => {
    for (const s of Object.values(SPECS)) expect(s.tickSize * s.multiplier).toBeCloseTo(s.tickValue, 9);
    expect(pnlUsd(SPECS.MES, 2, 5700, 5701)).toBe(10); // 2 contracts x 1 point x $5
    expect(pnlUsd(SPECS.ZB, -1, 117.5, 117 + 15 / 32)).toBeCloseTo(31.25, 9); // short 1, down one 32nd
  });
});
