import { SecType, type Contract } from "@stoqey/ib";
import { SPECS } from "../contracts";
import type { FuturesContract, Root } from "../types";

const MONTH_CODES = "FGHJKMNQUVXZ";

/** The IBKR contract for one of our futures. With a resolved conId IBKR needs nothing else; before that, symbol + month + exchange + trading class is unambiguous. */
export function toIbContract(c: FuturesContract): Contract {
  const spec = SPECS[c.root];
  if (c.brokerId) return { conId: c.brokerId, exchange: spec.exchange };
  return {
    secType: SecType.FUT,
    symbol: c.root,
    tradingClass: c.root,
    exchange: spec.exchange,
    currency: spec.currency,
    lastTradeDateOrContractMonth: c.month,
    multiplier: spec.multiplier,
  };
}

/**
 * Our contract code (MESZ6, ZBZ6) for a contract IBKR sent us. IBKR's own localSymbol is not uniform across
 * CME and CBOT products, so derive it from symbol and expiry instead.
 */
export function codeOf(c: Contract): string {
  const ym = c.lastTradeDateOrContractMonth ?? "";
  const month = Number(ym.slice(4, 6));
  if (!c.symbol || !month) return c.localSymbol ?? String(c.conId ?? "?");
  return `${c.symbol}${MONTH_CODES[month - 1]}${ym.slice(3, 4)}`;
}

export const isRoot = (s: string | undefined): s is Root => !!s && s in SPECS;

/** "20261218" to a UTC date, or null. */
export function parseIbDate(s: string | undefined): Date | null {
  if (!s || !/^\d{8}/.test(s)) return null;
  return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))));
}

export async function until(ok: () => boolean, timeoutMs: number, what: string) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`${what} timed out after ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}
