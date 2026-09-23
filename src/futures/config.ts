import type { Root } from "./types";

const env = (key: string, fallback?: string) => process.env[key] ?? fallback;
const num = (key: string, fallback: number) => Number(env(key, String(fallback)));

/** Protective stop distance per root, in ticks. MES 16 = 4 pts = $20, MNQ 40 = 10 pts = $20, ZB 8 = 8/32 = $250 per contract. */
const DEFAULT_STOP_TICKS: Record<Root, number> = { MES: 16, MNQ: 40, ZB: 8 };

/** A per-root setting (`<KEY>_MES`) that falls back to the plain `<KEY>`, then to `fallback`. */
const perRoot = (key: string, fallback: number) => (root: Root) => num(`${key}_${root}`, num(key, fallback));

export const futuresConfig = {
  roots: env("FUT_ROOTS", "MES")!.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) as Root[],
  /** sim: fills simulated against the live IBKR book, nothing sent. ibkr: orders go to IBKR (paper unless IB_LIVE=true). */
  exec: env("FUT_EXEC", "sim") as "sim" | "ibkr",
  /** One decision per root every this many seconds. */
  decisionSeconds: num("FUT_DECISION_S", 30),
  /** The model is asked about the move over this many minutes. */
  horizonMinutes: num("FUT_HORIZON_MIN", 5),
  /** Hard limit on how long one model call may take before the cycle gives up and holds. */
  modelTimeoutMs: num("FUT_MODEL_TIMEOUT_MS", 5_000),
  /** Contracts per position, and the absolute cap per root. */
  qty: num("FUT_QTY", 1),
  maxContracts: num("FUT_MAX_CONTRACTS", 1),
  /** Go long at P(up) >= enter, short at P(up) <= 1 - enter. */
  enterProb: num("FUT_ENTER_PROB", 0.6),
  /** Go flat when |P(up) - 0.5| <= flatBand. Between the band and `enter`, keep the current position. */
  flatBand: num("FUT_FLAT_BAND", 0.05),
  /**
   * Act on the average of the model's last N up-probabilities, not a single reading. No position is opened or
   * changed until N consecutive readings exist (a cycle without an answer starts the count again). 1 = act on each.
   */
  smoothN: num("FUT_SMOOTH_N", 2),
  /** Once in a position, the model cannot shrink or reverse it for this many minutes (risk gates and the stop still can). 0 = off. Defaults to the horizon. */
  minHoldMinutes: num("FUT_MIN_HOLD_MIN", num("FUT_HORIZON_MIN", 5)),
  /** false: a signal against the position goes flat first; the other side needs its own signal on a later cycle. */
  allowFlip: env("FUT_ALLOW_FLIP", "false") === "true",
  /**
   * Chase filter: no new position in a direction the market already moved more than this many typical moves in,
   * over the last `chaseMinutes` (the typical move is the standard deviation of that window's move over the last
   * 2 hours). 0 = off. Exits and holding are never blocked.
   */
  chaseSigma: num("FUT_CHASE_SIGMA", 0),
  chaseMinutes: num("FUT_CHASE_MIN", num("FUT_HORIZON_MIN", 5)),
  /** Take-profit: a resting limit this many ticks from the average entry, one-cancels-all with the stop. 0 = off. Per root via FUT_TP_TICKS_<ROOT>. */
  takeProfitTicks: perRoot("FUT_TP_TICKS", 0),
  /**
   * Trailing stop: once the best exit price since entry is `trailStartTicks` in profit, the stop follows it at
   * `trailTicks` behind (never looser than the original stop). 0 = off. Per root via FUT_TRAIL_START_TICKS_<ROOT>, FUT_TRAIL_TICKS_<ROOT>.
   */
  trailStartTicks: perRoot("FUT_TRAIL_START_TICKS", 0),
  trailTicks: perRoot("FUT_TRAIL_TICKS", 0),
  /**
   * cross: new positions are IOC limits at the far touch (pay the spread). passive: they rest at our own touch
   * (a buy at the bid) for up to `passiveCycles` decision cycles, then are cancelled if unfilled. Exits always cross.
   */
  entryMode: (env("FUT_ENTRY", "cross") === "passive" ? "passive" : "cross") as "cross" | "passive",
  passiveCycles: num("FUT_PASSIVE_CYCLES", 2),
  /** Model input version: v1 (original) or v2 (moves in units of normal, range and average context, no book sizes). */
  stateVersion: (env("FUT_STATE", "v1") === "v2" ? "v2" : "v1") as "v1" | "v2",
  /** Log file prefix under data/: <name>-events.jsonl, <name>-decisions.jsonl, <name>-fills.jsonl. Give a side-by-side instance its own. */
  logName: env("FUT_LOG_NAME", "futures")!,
  /** Entries and exits are IOC limits at the touch plus this many ticks. */
  slipTicks: num("FUT_SLIP_TICKS", 0),
  /** No new risk when the spread is wider than this. */
  maxSpreadTicks: num("FUT_MAX_SPREAD_TICKS", 2),
  stopTicks: (root: Root) => num(`FUT_STOP_TICKS_${root}`, DEFAULT_STOP_TICKS[root]),
  /** Across all roots, per trading day: realized + unrealized - fees. At or past it, flatten everything and stop until the next trading day. */
  dailyLossUsd: num("FUT_DAILY_LOSS_USD", 150),
  /** No new risk this many minutes before the daily close. */
  entryCutoffMinutes: num("FUT_ENTRY_CUTOFF_MIN", 10),
  /** Be flat this many minutes before the weekend close. */
  flattenBeforeWeekendMinutes: num("FUT_FLATTEN_WEEKEND_MIN", 15),
  /** Cancel every open order on the account at startup (ibkr only). Assumes the account is dedicated to this bot. */
  cancelOnStart: env("FUT_CANCEL_ON_START", "true") === "true",
  /** Send a flattening order on SIGINT/SIGTERM. Protective stops are left working either way. */
  flattenOnExit: env("FUT_FLATTEN_ON_EXIT", "false") === "true",
  /** Compare our position with the broker's every this many cycles. */
  reconcileEveryCycles: num("FUT_RECONCILE_CYCLES", 10),
  /** Give up on an order with no final status after this long, and reconcile. */
  orderTimeoutMs: num("FUT_ORDER_TIMEOUT_MS", 30_000),
  depthRows: num("FUT_DEPTH_ROWS", 0),
  port: num("FUT_PORT", 3001),
  historySize: 1000,
};

export type FuturesConfig = typeof futuresConfig;

/** One line describing the chase filter, profit protection and entry mode, for startup and backtest output. */
export function exitsLine(cfg: FuturesConfig, roots: Root[]) {
  const per = roots.map((r) => {
    const tp = cfg.takeProfitTicks(r), ts = cfg.trailStartTicks(r), tr = cfg.trailTicks(r);
    return `${r} stop ${cfg.stopTicks(r)}t, take-profit ${tp ? `${tp}t` : "off"}, trail ${ts && tr ? `${tr}t behind once +${ts}t` : "off"}`;
  });
  const chase = cfg.chaseSigma ? `chase filter ${cfg.chaseSigma} typical ${cfg.chaseMinutes}m moves` : "chase filter off";
  const entry = cfg.entryMode === "passive" ? `passive entries (rest ${cfg.passiveCycles} cycles)` : "entries cross the spread";
  return `${chase}; ${entry}; ${per.join("; ")}`;
}
