import { config } from "../config";
import { JevModel, type Action, type Decision, type DirectionQuestions, type Model } from "../model";
import type { Root } from "./types";

/** What the model sees each cycle. `FUT_STATE` picks the version: v1 (the original) or v2 (built to stop chasing). */
export type FuturesTradeState = FuturesTradeStateV1 | FuturesTradeStateV2;
export type StateVersion = "v1" | "v2";

/** v1: compact, relative, human-readable, like the Monad `TradeState`. */
export interface FuturesTradeStateV1 {
  market: string; // "MESZ6 Micro E-mini S&P 500 (CME)"
  root: Root;
  contract: string;
  timeChicago: string; // "Tue 09:42"
  horizonMinutes: number;
  decisionEverySeconds: number;
  tick: { size: number; valueUsd: number };
  mid: number;
  spreadTicks: number;
  /** Round trip cost in ticks: the spread crossed on entry and exit plus fees both sides. The move must beat this. */
  costTicks: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids)
  /** Top levels, best first, as "price x contracts". Only the touch unless depth is subscribed. */
  book: { bids: string[]; asks: string[] };
  returnsBps: { m1: number; m5: number; m15: number; m60: number };
  recentMids: string; // oldest..newest, one per minute over the last 30 minutes, space separated
  /** Prints over the horizon. Aggressor side is inferred from the quote. cvd = buy volume - sell volume, in contracts. */
  trades: { count: number; buyQty: number; sellQty: number; cvd: number; vwap: number | null; lastPrice: number | null; lastSide: "buy" | "sell" | null };
  position: { side: "long" | "short" | "flat"; contracts: number; entry: number | null; unrealizedTicks: number };
  session: { minutesToClose: number | null; closeIsWeekend: boolean };
  allowed: { buy: boolean; sell: boolean };
}

export const FUTURES_QUESTIONS: DirectionQuestions = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will this future be higher or lower than the current mid after `horizonMinutes` minutes?",
      goal: "Hold a small position in a CME/CBOT future. A decision is made every `decisionEverySeconds` seconds and the position is moved to match it. A clear buy means be long, a clear sell means be short, a near 50/50 answer means be flat, so the probabilities matter as much as the choice.",
      costs: "Changing position crosses the spread and pays fees; `costTicks` is the round trip cost in ticks. Only lean strongly one way if the expected move over the horizon beats it.",
      inputs: "`returnsBps` and `recentMids` show the path over the last hour. `trades.cvd` is aggressive buy minus sell volume over the horizon. `bookImbalance` and `book` show resting size at the touch. `session.minutesToClose` is time left before the daily or weekend close. `position` is what is held now. If `allowed.buy` is false a buy cannot add risk, and vice versa.",
    },
    criteria: {
      buy: "Mid more likely to be higher after `horizonMinutes` minutes, by more than `costTicks`.",
      sell: "Mid more likely to be lower after `horizonMinutes` minutes, by more than `costTicks`.",
    },
  },
};

/** A move over a window: in ticks, and in `sigma`, units of that window's typical move (null until there is enough history). */
export interface Move { ticks: number; sigma: number | null }

/**
 * v2, after the first paper session showed v1 answers following the past 5 minutes (+0.50 correlation) far more
 * than the next 5 (+0.08), and buying after bursts that then pulled back:
 *   - no top-of-book sizes or imbalance: they flipped sign on half of consecutive calls and pushed the answer around
 *   - every recent move also in units of its typical size, so a burst is visibly a burst
 *   - where price sits in its 30 and 60 minute range and against its 60 minute average: stretched or not
 *   - trade flow as a share of volume, one input among several rather than a highlighted signal
 *   - how long the current position has been held, and whether the US cash session is open
 */
export interface FuturesTradeStateV2 {
  version: 2;
  market: string;
  root: Root;
  contract: string;
  timeChicago: string;
  /** US cash equity hours, 08:30 to 15:00 Chicago on weekdays: more volume, different behaviour than overnight. */
  cashSession: boolean;
  horizonMinutes: number;
  decisionEverySeconds: number;
  tick: { size: number; valueUsd: number };
  mid: number;
  spreadTicks: number;
  costTicks: number;
  /** One standard deviation of the move over 1, 5 and 15 minutes, in ticks, from the last 2 hours. */
  typicalMoveTicks: { m1: number | null; m5: number | null; m15: number | null };
  moves: { m1: Move; m5: Move; m15: Move; m60: Move };
  /** Where the mid sits in its high-low range: 0 at the low, 1 at the high. */
  range: { m30: { position: number | null; widthTicks: number }; m60: { position: number | null; widthTicks: number } };
  /** Mid minus its 60 minute average, in ticks and in units of the typical 15 minute move. */
  vsAverage60: Move;
  recentMids: string;
  /** Aggressive buying minus selling over the horizon, as a share of volume (-1..1), and the volume in contracts. */
  flow: { share: number | null; contracts: number };
  position: { side: "long" | "short" | "flat"; contracts: number; entry: number | null; unrealizedTicks: number; heldMinutes: number | null };
  session: { minutesToClose: number | null; closeIsWeekend: boolean };
  allowed: { buy: boolean; sell: boolean };
}

export const FUTURES_QUESTIONS_V2: DirectionQuestions = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will this future be higher or lower than the current mid after `horizonMinutes` minutes?",
      goal: "Hold a small position in a CME/CBOT future. A decision is made every `decisionEverySeconds` seconds and the position is moved to match it. A clear buy means be long, a clear sell means be short, a near 50/50 answer means be flat, so the probabilities matter as much as the choice.",
      costs: "Changing position crosses the spread and pays fees; `costTicks` is the round trip cost in ticks. Only lean strongly one way if the expected move over the horizon beats it.",
      inputs: "`moves` gives the change over the last 1, 5, 15 and 60 minutes in ticks and in `sigma`, units of that window's typical move (`typicalMoveTicks`): around 1 is ordinary, 2 or more is an unusually fast move. `range` shows where the mid sits in its last 30 and 60 minute high-low range (0 at the low, 1 at the high), and `vsAverage60` how far it is from its 60 minute average. `flow.share` is aggressive buying minus selling over the horizon as a share of volume. `recentMids` is the path over the last 30 minutes. `position` is what is held now and for how long. `cashSession` says whether US cash equities are trading. If `allowed.buy` is false a buy cannot add risk, and vice versa.",
      judgement: "Judge the next `horizonMinutes` minutes, not the last few. A recent move can continue or partly reverse; decide which is more likely from its size relative to normal, where price sits in its range, and the longer path, rather than assuming the latest direction continues.",
    },
    criteria: {
      buy: "Mid more likely to be higher after `horizonMinutes` minutes, by more than `costTicks`.",
      sell: "Mid more likely to be lower after `horizonMinutes` minutes, by more than `costTicks`.",
    },
  },
};

/** Deterministic stand-in: momentum plus flow plus imbalance, squashed to a probability. Never use it with real money. */
export class FuturesMockModel implements Model<FuturesTradeState> {
  readonly name = "mock";

  async decide(s: FuturesTradeState): Promise<Decision> {
    const t0 = performance.now();
    let signal: number;
    if ("version" in s) {
      signal = (s.moves.m5.sigma ?? 0) * 0.8 + (s.moves.m15.sigma ?? 0) * 0.4 + (s.flow.share ?? 0) * 1.5;
    } else {
      const vol = s.trades.buyQty + s.trades.sellQty;
      const flow = vol ? s.trades.cvd / vol : 0;
      signal = s.returnsBps.m5 / 4 + s.returnsBps.m15 / 8 + flow * 1.5 + s.bookImbalance * 0.5;
    }
    const buy = 1 / (1 + Math.exp(-signal));
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    return {
      action, probabilities: { buy, sell: 1 - buy, hold: 0 }, upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(s).length / 4),
    };
  }
}

/** MODEL=jev uses Jev with the questions for the state version; anything else the mock. */
export const createFuturesModel = (version: StateVersion = "v1"): Model<FuturesTradeState> =>
  config.model === "jev" ? new JevModel<FuturesTradeState>(version === "v2" ? FUTURES_QUESTIONS_V2 : FUTURES_QUESTIONS) : new FuturesMockModel();
