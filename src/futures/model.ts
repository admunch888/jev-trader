import { config } from "../config";
import { JevModel, type Action, type Decision, type DirectionQuestions, type Model } from "../model";
import type { Root } from "./types";

/** What the model sees each cycle for one futures contract. Compact, relative, human-readable, like the Monad `TradeState`. */
export interface FuturesTradeState {
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

/** Deterministic stand-in: momentum plus flow plus imbalance, squashed to a probability. Never use it with real money. */
export class FuturesMockModel implements Model<FuturesTradeState> {
  readonly name = "mock";

  async decide(s: FuturesTradeState): Promise<Decision> {
    const t0 = performance.now();
    const vol = s.trades.buyQty + s.trades.sellQty;
    const flow = vol ? s.trades.cvd / vol : 0;
    const signal = s.returnsBps.m5 / 4 + s.returnsBps.m15 / 8 + flow * 1.5 + s.bookImbalance * 0.5;
    const buy = 1 / (1 + Math.exp(-signal));
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    return {
      action, probabilities: { buy, sell: 1 - buy, hold: 0 }, upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(s).length / 4),
    };
  }
}

/** MODEL=jev uses Jev with the futures questions; anything else the mock. */
export const createFuturesModel = (): Model<FuturesTradeState> =>
  config.model === "jev" ? new JevModel<FuturesTradeState>(FUTURES_QUESTIONS) : new FuturesMockModel();
