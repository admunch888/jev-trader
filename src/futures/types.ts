/**
 * Venue-neutral adapter interfaces for trading listed futures (MES, MNQ, ZB).
 *
 * The Monad loop in `src/trader.ts` talks to one concrete `Market`. A futures port talks to these three
 * seams instead, so the broker (IBKR today) can be swapped or replaced by a replay/backtest feed:
 *
 *   ContractSpec  static facts about a product: tick, multiplier, cycle, expiry and roll calendar, session
 *   MarketData    resolve the front contract, stream top of book, depth and prints, fetch bars
 *   Execution     place, modify, cancel, what-if margin, positions, account, order and fill streams
 *
 * Units: prices are in the exchange's quoted units as decimals (ZB 117'16 is 117.5), sizes are contracts,
 * money is USD. Timestamps are epoch milliseconds.
 */

export type Side = "buy" | "sell";
export type Root = "MES" | "MNQ" | "ZB";
/** CME month codes. */
export type MonthCode = "F" | "G" | "H" | "J" | "K" | "M" | "N" | "Q" | "U" | "V" | "X" | "Z";

// ---------------------------------------------------------------------------------------------------------
// ContractSpec
// ---------------------------------------------------------------------------------------------------------

export interface ContractSpec {
  root: Root;
  name: string;
  exchange: "CME" | "CBOT";
  currency: "USD";
  /** Minimum price increment in quoted units. */
  tickSize: number;
  /** USD per 1.00 of price. PnL = qty * (exit - entry) * multiplier. */
  multiplier: number;
  /** tickSize * multiplier. */
  tickValue: number;
  /** How humans quote it. ZB trades in 32nds of a point. */
  priceFormat: "decimal" | "32nds";
  /** Listed expiry months, in calendar order. */
  cycle: MonthCode[];
  /** Physically delivered contracts must be out before first notice (IBKR force-liquidates otherwise). */
  physicalDelivery: boolean;
  /** Placeholder commission + exchange + regulatory fee per contract per side, for pre-trade estimates only. Real fees arrive on each `ExecFill`. */
  estFeesPerSide: number;
  session: SessionHours;
  /** Calendar for the contract expiring in `month` (1-12) of `year`. Weekends only; exchange holidays are not modelled. */
  calendar(year: number, month: number): ContractCalendar;
}

export interface ContractCalendar {
  lastTradeDate: Date;
  /** Physically delivered only: last business day of the month before the contract month. */
  firstNoticeDate: Date | null;
  /** Stop opening new positions in this contract and move to the next one from this date. */
  rollDate: Date;
}

export interface SessionHours {
  /** Exchange time zone the hours are expressed in. */
  tz: string;
  /** Whether the product is in its electronic trading session at `at` (holidays and early closes not modelled). */
  isOpen(at: Date): boolean;
  /** Minutes until the session in progress at `at` closes, and whether that close starts the weekend. Null when closed. */
  nextClose(at: Date): { minutes: number; weekend: boolean } | null;
  /** The trading day `at` belongs to, as YYYY-MM-DD. A Globex day starts at the 17:00 Chicago open, so Sunday evening counts as Monday. */
  tradingDay(at: Date): string;
}

/** One listed expiry: the thing you subscribe to and trade. */
export interface FuturesContract {
  root: Root;
  /** YYYYMM, the form IBKR's `lastTradeDateOrContractMonth` takes. */
  month: string;
  /** Exchange-style symbol, e.g. MESZ6, ZBZ6. Used as the key in books, fills and positions. */
  code: string;
  calendar: ContractCalendar;
  /** Broker's own identifier once resolved (IBKR conId). */
  brokerId?: number;
}

// ---------------------------------------------------------------------------------------------------------
// MarketData
// ---------------------------------------------------------------------------------------------------------

export interface BookLevel {
  price: number;
  /** Contracts. */
  size: number;
}

/** What the decision loop reads each cycle; the futures analogue of `Book` in `src/market.ts`. */
export interface BookSnapshot {
  contract: string;
  ts: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mid: number;
  spreadTicks: number;
  /** (bid depth - ask depth) / (bid depth + ask depth) over the levels we have. -1..1 */
  imbalance: number;
  /** Best first. Empty unless depth is subscribed (needs a CME/CBOT depth-of-book data subscription on IBKR). */
  levels: { bids: BookLevel[]; asks: BookLevel[] };
  last: number | null;
  /** Delayed data must never drive live orders. */
  delayed: boolean;
}

/** A trade print. */
export interface Print {
  ts: number;
  price: number;
  size: number;
  /** Aggressor side. IBKR does not tag it, so adapters infer it from the prevailing quote; null when at mid or unknown. */
  side: Side | null;
}

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type BarSize = "5s" | "1m" | "5m";

/** What data is flowing for a contract, and if something is missing, a short reason. */
export interface DataHealth {
  quotes: "live" | "delayed" | "none";
  prints: "live" | "none";
  reason: string | null;
}
export type FeedStatus = "connecting" | "connected" | "disconnected";

export interface MarketData {
  readonly status: FeedStatus;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** The contract to trade for `root` at `at` (default now): the first listed expiry whose roll date has not passed, with `brokerId` filled in. */
  resolve(root: Root, at?: Date): Promise<FuturesContract>;
  /** Start top of book and prints; `depthRows` > 0 also subscribes to market depth. */
  subscribe(contract: FuturesContract, opts?: { depthRows?: number }): Promise<void>;
  unsubscribe(contract: FuturesContract): void;
  /** Latest snapshot, or null before the first bid and ask arrive. Cheap: served from memory, no round trip. */
  book(contract: FuturesContract): BookSnapshot | null;
  onBook(contract: FuturesContract, cb: (b: BookSnapshot) => void): () => void;
  onPrint(contract: FuturesContract, cb: (p: Print) => void): () => void;
  /** Historical bars ending now, including the overnight session. `lookback` in IBKR duration form, e.g. "1 D", "3600 S". */
  bars(contract: FuturesContract, size: BarSize, lookback: string): Promise<Bar[]>;
  /** Optional: data health per contract, for status lines and startup checks. */
  health?(contract: FuturesContract): DataHealth;
}

// ---------------------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------------------

export type OrderKind = "limit" | "market" | "stop";
export type TimeInForce = "day" | "gtc" | "ioc";

export interface OrderRequest {
  /** Our id for this order, unique per session. Echoed on every update and fill (IBKR `orderRef`). */
  ref: string;
  contract: FuturesContract;
  side: Side;
  /** Contracts, positive integer. */
  qty: number;
  kind: OrderKind;
  /** Limit price, or trigger for a stop. Must sit on the tick grid. */
  price?: number;
  tif: TimeInForce;
  /** One-cancels-all group: when an order in the group fills, the broker cancels the others (a stop and its take-profit). */
  oca?: string;
  /** Attach an OCA take-profit limit and stop-loss stop, as absolute prices. Children get refs `${ref}:tp` and `${ref}:sl`. */
  bracket?: { takeProfit: number; stopLoss: number };
}

export type OrderState = "pending" | "working" | "partial" | "filled" | "cancelled" | "rejected";

export interface OrderUpdate {
  ref: string;
  brokerId: number;
  state: OrderState;
  filled: number;
  remaining: number;
  avgPrice: number | null;
  reason?: string;
  ts: number;
}

export interface ExecFill {
  ref: string;
  /** Broker execution id; unique, use it to de-duplicate replays after reconnect. */
  execId: string;
  contract: string;
  side: Side;
  qty: number;
  price: number;
  ts: number;
  /** USD, all-in. Null if the broker never reported it. */
  commission: number | null;
}

export interface BrokerPosition {
  contract: string;
  /** Signed contracts: long > 0, short < 0. */
  qty: number;
  /** Average price in quoted units (IBKR reports avgCost including the multiplier; adapters divide it out). */
  avgPrice: number;
}

export interface AccountState {
  netLiquidation: number;
  availableFunds: number;
  initMargin: number;
  maintMargin: number;
}

/** Margin and commission impact of an order, without sending it. */
export interface WhatIf {
  initMarginChange: number;
  maintMarginChange: number;
  commission: number | null;
}

export type ExecStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface Execution {
  /** Optional: connection state, for brokers that can drop and come back. Absent means always connected (simulation). */
  readonly status?: ExecStatus;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Send an order. Resolves with the broker id once it is transmitted, not once it is working; watch `onOrder`. */
  place(req: OrderRequest): Promise<number>;
  /** Cancel/replace in place: new price and/or quantity for a working order. */
  modify(ref: string, change: { price?: number; qty?: number }): Promise<void>;
  cancel(ref: string): Promise<void>;
  /** Kill switch: cancel every working order for this account, including ones placed by other sessions. */
  cancelAll(): Promise<void>;
  whatIf(req: OrderRequest): Promise<WhatIf>;
  positions(): Promise<BrokerPosition[]>;
  account(): Promise<AccountState>;
  onOrder(cb: (u: OrderUpdate) => void): () => void;
  onFill(cb: (f: ExecFill) => void): () => void;
}
