import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";

/** Models answer buy or sell. `hold` only appears on late blocks (no decision was made). */
export type Action = "buy" | "sell" | "hold";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: "MON-USDC";
  block: number;
  horizonBlocks: number; // the question is about the move over this many blocks
  blockMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  /** Cumulative resting MON within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string; // oldest..newest, sampled every 5 blocks over the horizon, space separated
  /** Taker prints over the last `horizonBlocks`. cvdMon = taker buy volume - taker sell volume. */
  trades: { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null; lastPrice: number | null; lastSide: "buy" | "sell" | null };
  recentTrades: string[]; // newest last, "block side size @ price"
  allowed: { buy: boolean; sell: boolean };
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
  /** The exact model version that answered (an alias like jev-latest resolves to one), when the provider reports it. */
  modelVersion?: string;
}

/** Generic over the state it reads, so the futures loop can reuse the same models with its own state. */
export interface Model<S = TradeState> {
  readonly name: string;
  decide(state: S): Promise<Decision>;
}

/** One two-way choice, `direction`: buy or sell. The instructions are what differ between markets. */
export type DirectionQuestions = {
  readonly direction: {
    readonly type: "choice";
    readonly instructions: Readonly<Record<string, string>>;
    readonly criteria: { readonly buy: string; readonly sell: string };
  };
};

const QUESTIONS: DirectionQuestions = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will MON be higher or lower than the current mid after `horizonBlocks` more blocks?",
      goal: "Trade MON-USDC on Kuru. Blocks are ~300ms; `horizonBlocks` (~30 s) is the horizon. A decision is made every few blocks and held until the next one. The trade crosses the spread (`spreadBps`), so the move must beat that cost.",
      timing: "The order executes as an immediate-or-cancel market order in the next block.",
      inputs: "Taker flow is the strongest signal: `trades.cvdMon` (taker buys minus taker sells over the horizon), `trades.lastSide` and `recentTrades` show who is hitting the book. `depth` and `book` show resting liquidity per side at several distances from mid; thin depth on one side means price moves easily that way. `returnsBps` and `recentMids` show the path over the horizon. If `allowed.buy` is false the trade will be a sell regardless, and vice versa.",
    },
    criteria: {
      buy: "Buy MON now: mid more likely to be higher after `horizonBlocks` blocks, by more than the spread.",
      sell: "Sell MON now: mid more likely to be lower after `horizonBlocks` blocks, by more than the spread.",
    },
  },
};

/** Real Jev via the AI SDK. Swap-in is the MODEL env var. */
export class JevModel<S = TradeState> implements Model<S> {
  readonly name = config.jevModelId;
  private model = typeSafeAi.evaluationModel(config.jevModelId);
  /** The version that answered first; a later answer from a different one means the alias moved mid-run. */
  private version: string | null = null;

  constructor(private questions: DirectionQuestions = QUESTIONS, private log: (msg: string) => void = console.warn) {
    if (/latest/i.test(config.jevModelId)) this.log(`JEV_MODEL_ID=${config.jevModelId} is an alias: a new Jev version can replace it without notice. Pin a version for tests.`);
  }

  async decide(state: S): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: this.questions, maxRetries: 0 });
    const a = r.answers.direction;
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = p.buy ?? 0, sell = p.sell ?? 0;
    const modelVersion = r.response?.modelId;
    if (modelVersion && modelVersion !== this.version) {
      if (this.version) this.log(`WARNING: Jev version changed from ${this.version} to ${modelVersion}; thresholds were set on the old one`);
      else this.log(`Jev answering as ${modelVersion}`);
      this.version = modelVersion;
    }
    return {
      action: a.choice as Action,
      probabilities: { buy, sell, hold: 0 },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
      ...(modelVersion ? { modelVersion } : {}),
    };
  }
}

/** Deterministic stand-in: momentum + imbalance + mean reversion toward flat. */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    // momentum + book imbalance + noise, pulled back toward flat so it trades both ways
    const flow = state.trades.buyMon + state.trades.sellMon ? state.trades.cvdMon / (state.trades.buyMon + state.trades.sellMon) : 0;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + this.noise(state.block);
    const buy = 1 / (1 + Math.exp(-signal)); // binary softmax
    const probabilities = { buy, sell: 1 - buy, hold: 0 };
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    await Bun.sleep(80); // stand in for inference time so the pipeline behaves like production
    return {
      action, probabilities,
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  private noise(block: number) {
    let h = block * 2654435761 >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

export const createModel = (): Model => (config.model === "jev" ? new JevModel() : new MockModel());
