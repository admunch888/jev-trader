import type { ContractCalendar, ContractSpec, FuturesContract, MonthCode, Root, SessionHours } from "./types";

/**
 * Contract specs for Micro E-mini S&P 500 (MES), Micro E-mini Nasdaq-100 (MNQ) and the 30-year Treasury Bond
 * future (ZB). Tick sizes, multipliers, cycles and expiry rules follow the CME/CBOT rulebooks; exchange holidays
 * are not modelled, so a calendar date that lands on a holiday is off by a business day. Check the broker's
 * contract details (IBKR returns the real last trade date) before relying on a date here near an expiry.
 */

const MONTH_CODES: MonthCode[] = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
const QUARTERLY: MonthCode[] = ["H", "M", "U", "Z"];

/** CME Globex hours for these three: Sunday 17:00 to Friday 16:00 Chicago time, with a 16:00 to 17:00 break Monday to Thursday. */
const GLOBEX: SessionHours = {
  tz: "America/Chicago",
  isOpen(at) {
    const { weekday, minutes } = chicago(at);
    const open = 17 * 60, close = 16 * 60;
    if (weekday === 6) return false; // Saturday
    if (weekday === 0) return minutes >= open; // Sunday evening open
    if (weekday === 5) return minutes < close; // Friday close
    return minutes < close || minutes >= open; // daily maintenance break
  },
  nextClose(at) {
    if (!this.isOpen(at)) return null;
    const { weekday, minutes } = chicago(at);
    const close = 16 * 60;
    const evening = minutes >= 17 * 60; // this session closes tomorrow at 16:00
    return {
      minutes: evening ? 24 * 60 - minutes + close : close - minutes,
      weekend: weekday === 5 || (weekday === 4 && evening),
    };
  },
  tradingDay(at) {
    return chicagoDate(new Date(at.getTime() + 7 * 3_600_000)); // 17:00 Chicago + 7h = midnight of the next trading day
  },
};

/** Equity index futures: last trade on the third Friday of the contract month; the market rolls 8 days earlier (the Thursday of the week before). */
function equityCalendar(year: number, month: number): ContractCalendar {
  const lastTradeDate = thirdFriday(year, month);
  return { lastTradeDate, firstNoticeDate: null, rollDate: addDays(lastTradeDate, -8) };
}

/**
 * Treasury bond futures (physically delivered):
 * first notice is the last business day of the month before the contract month, last trade is the 7th business
 * day before the last business day of the contract month. Longs can be assigned delivery from first notice, and
 * IBKR closes out physically delivered positions ahead of it, so roll `ZB_ROLL_BUSINESS_DAYS` before first notice.
 * Confirm the current IBKR close-out deadline for ZB in TWS; if it is earlier than this, raise the constant.
 */
const ZB_ROLL_BUSINESS_DAYS = 3;
function treasuryCalendar(year: number, month: number): ContractCalendar {
  const [py, pm] = month === 1 ? [year - 1, 12] : [year, month - 1];
  const firstNoticeDate = lastBusinessDay(py, pm);
  return {
    lastTradeDate: addBusinessDays(lastBusinessDay(year, month), -7),
    firstNoticeDate,
    rollDate: addBusinessDays(firstNoticeDate, -ZB_ROLL_BUSINESS_DAYS),
  };
}

export const SPECS: Record<Root, ContractSpec> = {
  MES: {
    root: "MES", name: "Micro E-mini S&P 500", exchange: "CME", currency: "USD",
    tickSize: 0.25, multiplier: 5, tickValue: 1.25, priceFormat: "decimal",
    cycle: QUARTERLY, physicalDelivery: false,
    estFeesPerSide: 0.62, // placeholder: replace with your IBKR commission tier + CME fees
    session: GLOBEX, calendar: equityCalendar,
  },
  MNQ: {
    root: "MNQ", name: "Micro E-mini Nasdaq-100", exchange: "CME", currency: "USD",
    tickSize: 0.25, multiplier: 2, tickValue: 0.5, priceFormat: "decimal",
    cycle: QUARTERLY, physicalDelivery: false,
    estFeesPerSide: 0.62, // placeholder
    session: GLOBEX, calendar: equityCalendar,
  },
  ZB: {
    root: "ZB", name: "U.S. Treasury Bond", exchange: "CBOT", currency: "USD",
    tickSize: 1 / 32, multiplier: 1000, tickValue: 31.25, priceFormat: "32nds",
    cycle: QUARTERLY, physicalDelivery: true,
    estFeesPerSide: 2.0, // placeholder
    session: GLOBEX, calendar: treasuryCalendar,
  },
};

/** The contract to trade at `at`: the first listed expiry whose roll date is still ahead. */
export function frontContract(root: Root, at: Date = new Date()): FuturesContract {
  const spec = SPECS[root];
  let y = at.getUTCFullYear(), m = at.getUTCMonth() + 1;
  for (let i = 0; i < 24; i++) {
    if (spec.cycle.includes(MONTH_CODES[m - 1]!)) {
      const calendar = spec.calendar(y, m);
      if (calendar.rollDate.getTime() > startOfUtcDay(at)) return contractFor(root, y, m);
    }
    if (++m > 12) { m = 1; y++; }
  }
  throw new Error(`no listed ${root} contract within 24 months of ${at.toISOString()}`);
}

export function contractFor(root: Root, year: number, month: number): FuturesContract {
  const code = MONTH_CODES[month - 1]!;
  if (!SPECS[root].cycle.includes(code)) throw new Error(`${root} does not list month ${month}`);
  return {
    root,
    month: `${year}${String(month).padStart(2, "0")}`,
    code: `${root}${code}${year % 10}`,
    calendar: SPECS[root].calendar(year, month),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Tick math. Everything that reaches the broker goes through here so prices are exactly on the grid.
// ---------------------------------------------------------------------------------------------------------

export const toTicks = (spec: ContractSpec, price: number) => Math.round(price / spec.tickSize);
export const fromTicks = (spec: ContractSpec, ticks: number) => clean(ticks * spec.tickSize);
export const roundToTick = (spec: ContractSpec, price: number) => fromTicks(spec, toTicks(spec, price));
export const onTick = (spec: ContractSpec, price: number) => Math.abs(price - roundToTick(spec, price)) < 1e-9;
/** USD PnL of `qty` signed contracts moving from `entry` to `exit`. */
export const pnlUsd = (spec: ContractSpec, qty: number, entry: number, exit: number) => qty * (exit - entry) * spec.multiplier;

/** "5712.25" for index futures, "117'16" for ZB (points and 32nds). */
export function formatPrice(spec: ContractSpec, price: number): string {
  if (spec.priceFormat === "decimal") return price.toFixed(2);
  const ticks = toTicks(spec, price);
  const sign = ticks < 0 ? "-" : "";
  const abs = Math.abs(ticks);
  return `${sign}${Math.floor(abs / 32)}'${String(abs % 32).padStart(2, "0")}`;
}

/** Parse "117'16" (or a plain decimal) into a decimal price. */
export function parsePrice(spec: ContractSpec, s: string): number {
  if (spec.priceFormat === "decimal" || !s.includes("'")) return Number(s);
  const [pts, n32] = s.split("'");
  const sign = pts!.trim().startsWith("-") ? -1 : 1;
  return sign * (Math.abs(Number(pts)) + Number(n32) / 32);
}

// ---------------------------------------------------------------------------------------------------------
// Calendar helpers. Dates are UTC midnight of the calendar day.
// ---------------------------------------------------------------------------------------------------------

const clean = (x: number) => Math.round(x * 1e9) / 1e9;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const startOfUtcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export function addBusinessDays(d: Date, n: number): Date {
  let out = d;
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0;) {
    out = addDays(out, step);
    if (!isWeekend(out)) left--;
  }
  return out;
}

export function thirdFriday(year: number, month: number): Date {
  const first = utc(year, month, 1).getUTCDay();
  return utc(year, month, 1 + ((5 - first + 7) % 7) + 14);
}

export function lastBusinessDay(year: number, month: number): Date {
  let d = utc(year, month + 1, 0); // day 0 of next month = last day of this one
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

const CHICAGO = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const CHICAGO_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
const chicagoDate = (at: Date) => CHICAGO_DATE.format(at);

function chicago(at: Date): { weekday: number; minutes: number } {
  const parts = Object.fromEntries(CHICAGO.formatToParts(at).map((p) => [p.type, p.value]));
  return { weekday: WEEKDAYS.indexOf(parts.weekday!), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
