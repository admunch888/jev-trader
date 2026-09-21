# Futures trader (MES, MNQ, ZB on IBKR)

A futures trader for Interactive Brokers, separate from the Monad bot: same `Model` (mock or Jev), its own state, policy, risk gates and loop. `bun run futures` starts it in simulation by default: real IBKR quotes, simulated fills, nothing sent. The Monad bot is unchanged apart from `Model` becoming generic over its state.

## Layout

    main.ts             entry point (bun run futures): one trader per root, shared connections and loss guard
    trader.ts           FuturesTrader: the decision loop, orders, protective stop, position and PnL, roll
    policy.ts           probability -> target position, risk gates, account-wide daily loss guard (pure)
    model.ts            FuturesTradeState, the Jev questions for futures, a mock stand-in
    sim.ts              SimExecution (fills against any MarketData) and ManualMarketData (tests, replay)
    server.ts           GET / , /history?root= , /events SSE on FUT_PORT
    config.ts           FUT_* env
    types.ts            ContractSpec, MarketData, Execution and the shared types. Venue neutral.
    contracts.ts        MES, MNQ, ZB specs: tick, multiplier, cycle, expiry / first notice / roll calendar,
                        Globex session, tick math, 32nds formatting for ZB
    *.test.ts           calendars, session, tick math, policy, and the loop end to end on the simulator
    ibkr/config.ts      IB_* env, paper vs live port guard
    ibkr/contract.ts    our FuturesContract <-> IBKR Contract
    ibkr/marketData.ts  IbkrMarketData: resolve front month (conId + real last trade date), top of book,
                        tick-by-tick prints, optional depth, historical bars. IBApiNext (auto-reconnect).
    ibkr/execution.ts   IbkrExecution: place / modify / cancel / cancelAll, brackets, whatIf margin,
                        positions, account summary, order and fill streams with commissions. IBApi.
    backtest/format.ts  tick store: one JSONL file per contract per trading day, reader (gzip ok), writer, index
    backtest/replay.ts  ReplayMarketData: recorded ticks in, book / prints / minute bars out; merges contracts by time
    backtest/engine.ts  runBacktest: the live FuturesTrader on a replay clock, SimExecution as the exchange
    backtest/report.ts  round trips, PnL breakdown, drawdown, daily Sharpe, buy and hold; summary/trades/equity files
    backtest/cli.ts     bun run backtest
    backtest/record.ts  bun run record: live IBKR quotes and prints into the tick store
    backtest/fetch.ts   bun run fetch-ticks: IBKR historical ticks into the tick store
    backtest/synth.ts   seeded random-walk ticks for trying it and for tests
    ../../scripts/ibkr-smoke.ts   read-only check against a running TWS / Gateway

## The three seams

| Interface | Replaces in the Monad bot | Notes |
|---|---|---|
| `ContractSpec` | hardcoded MON-USDC tick and size in `config.ts` / `market.ts` | Multiplier drives PnL (`pnlUsd`). ZB is physically delivered, so its roll date sits ahead of first notice. |
| `MarketData` | `book.ts` + `trades.ts` + `chain.ts` | `book()` is served from memory, so the decision loop reads it with no round trip. Prints carry an inferred aggressor side because IBKR does not tag it. `delayed: true` on a snapshot means it must not drive live orders. |
| `Execution` | `Market.send` / `pollPending` | Orders are keyed by our `ref` (IBKR `orderRef`). Fills carry the real commission. `whatIf` gives margin impact without routing. |

## Contracts

| | MES | MNQ | ZB |
|---|---|---|---|
| Exchange | CME | CME | CBOT |
| Tick | 0.25 | 0.25 | 1/32 |
| Multiplier | $5 | $2 | $1,000 |
| Tick value | $1.25 | $0.50 | $31.25 |
| Months | H M U Z | H M U Z | H M U Z |
| Last trade | 3rd Friday | 3rd Friday | 7th business day before month end |
| Roll | 8 days before last trade | 8 days before last trade | 3 business days before first notice |

Calendars skip weekends but not exchange holidays; `IbkrMarketData.resolve` replaces the last trade date with IBKR's. Before trading ZB, check the IBKR close-out deadline for physically delivered futures in TWS and raise `ZB_ROLL_BUSINESS_DAYS` if it is earlier. `estFeesPerSide` values are placeholders; set them from your commission tier.

## Running against IBKR

1. Run TWS or IB Gateway logged into a **paper** account, with the API enabled (Configure > API > Settings: enable socket clients; trusted IP 127.0.0.1).
2. Market data: CME real-time for MES/MNQ and CBOT real-time for ZB (non-professional bundles cover both). Depth needs the depth-of-book add-on. Without them, set `IB_MARKET_DATA_TYPE=3` for delayed data and treat it as display only.
3. `IB_PORT=4002 bun run scripts/ibkr-smoke.ts` (4002 Gateway paper, 7497 TWS paper). It resolves the three front months, prints quotes, bars, account, positions and a what-if margin for one lot. It places no orders.

`IbkrExecution` refuses the live ports (4001, 7496) unless `IB_LIVE=true`.

**When data or the connection goes missing.** A few seconds after `bun run futures` starts, it prints a data check per product (`live quotes, trades on`, or what is missing and why). Quotes, trades and depth recover independently: a missing subscription, missing permissions or a competing live session is explained once in the log with the fix, the book is cleared so nothing trades on a stale quote (cycles show `no quote: <reason>`), and the stream is retried every `IB_DATA_RETRY_S` (120 s), so fixing the account needs no restart. If the order connection drops (the Gateway's daily restart), orders are refused and the loop holds under the `broker` gate while it reconnects (5 s doubling to `IB_RECONNECT_MAX_S`); it then re-requests open orders and today's executions so anything that filled meanwhile is applied once. Protective stops live at IBKR and keep working throughout. If the Gateway loses IBKR's servers (1100) orders pause until IBKR reports the link restored.

## The loop

Every `FUT_DECISION_S` seconds, per root (roots are staggered across the interval):

1. Bookkeeping: expire orders stuck without a final status, roll to the next contract once flat past the roll date, start a new trading day's PnL at the 17:00 Chicago open, reconcile with the broker every `FUT_RECONCILE_CYCLES` (adopting the broker's position if they disagree).
2. Read the book from memory and work out the risk gates.
3. Unless a gate already decides (halted, roll, weekend, stop breached, session closed), ask the model buy or sell for the next `FUT_HORIZON_MIN` minutes. No answer within `FUT_MODEL_TIMEOUT_MS` means hold.
4. Target position from the probability of up: long at `FUT_ENTER_PROB` or above, short at `1 - FUT_ENTER_PROB` or below, flat within `FUT_FLAT_BAND` of 50/50, otherwise keep. Hysteresis keeps a wavering model from churning.
5. Risk gates can only move the target toward flat:

| Gate | Effect |
|---|---|
| daily loss (`FUT_DAILY_LOSS_USD`, summed over all roots) | flatten, no new risk until the next trading day |
| past the roll date | flatten, then roll |
| within `FUT_FLATTEN_WEEKEND_MIN` of the Friday close | flatten |
| price through the stop level with no stop working | flatten |
| order connection down (Gateway restarting) | hold: no model call, no orders |
| session closed | do nothing |
| within `FUT_ENTRY_CUTOFF_MIN` of the daily close, spread over `FUT_MAX_SPREAD_TICKS`, delayed data with real orders, feed down | exits only |
| `FUT_MAX_CONTRACTS` | cap |

6. If the target differs from the position and nothing is in flight: one IOC limit at the touch (plus `FUT_SLIP_TICKS`) for the difference. A flip is one order. Orders that reduce the position pull the stop first so both cannot fill.
7. Keep exactly one GTC stop covering the whole position, `FUT_STOP_TICKS_<ROOT>` from the average entry. It lives at the broker, so it protects the position if this process dies.

Position and PnL come from fills (with real commissions on IBKR). An order counts as settled only when its final status and all its fills have arrived, since IBKR sends them separately and in either order. Every cycle is written to `data/futures-events.jsonl` and streamed on `/events`.

## Running

    bun run test:futures                        # 53 tests, no broker needed
    FUT_ROOTS=MES,MNQ,ZB bun run futures        # sim: real quotes, simulated fills
    FUT_EXEC=ibkr bun run futures               # orders to the IBKR paper account on IB_PORT
    MODEL=jev TYPESAFE_AI_API_KEY=... bun run futures   # Jev instead of the mock

Before `FUT_EXEC=ibkr`: use a dedicated paper account (startup cancels every open order on it unless `FUT_CANCEL_ON_START=false`), and run sim for a while first. Real money needs `IB_LIVE=true` and a live port on top of `FUT_EXEC=ibkr`.

## Backtesting

The backtester replays recorded quotes through the **same** `FuturesTrader`, policy, risk gates and stop logic the live bot runs, with `SimExecution` as the exchange, on a virtual clock. Nothing in the loop knows it is a backtest.

**1. Get ticks.** Either record them live, or download a window of history:

    bun run record                                   # leave running; FUT_ROOTS, real-time data needed
    bun run fetch-ticks --root MES --from 2026-09-22T13:30:00Z --to 2026-09-22T16:00:00Z

Both write `data/ticks/<ROOT>/<CODE>/<trading day>.jsonl` (format in `backtest/format.ts`; `.jsonl.gz` also reads). The recorder is the better source: it captures exactly what the live bot sees, and records the next contract too from 10 days before a roll. `fetch-ticks` is limited by IBKR (1000 ticks a request, about 60 requests per 10 minutes, whole-second stamps), so it suits hours, not months. Data from any vendor can be converted to the same format.

**2. Run.**

    bun run backtest --roots MES,ZB --from 2026-09-22 --to 2026-09-26
    bun run backtest --synthetic 5 --roots MES,MNQ,ZB     # no data needed: seeded random walk, not market data

| Flag | Default | |
|---|---|---|
| `--latency` | 250 ms | Decision to exchange. Orders and cancels are matched against the book as it is when they arrive, so an IOC at a stale price misses. Set it to your measured model + network time. |
| `--respect-size` | off | Cap marketable fills at the displayed touch size. |
| `--warmup` | 60 min | Replay before the first decision so returns and bars have history. |
| `--stale` | 120 s | Skip a cycle when the contract's last quote is older (data gaps, missing files). |
| `--decision-s --horizon-min --enter --flat-band --qty --max-contracts --stop-ticks --daily-loss --max-spread --slip-ticks` | FUT_* | Strategy overrides. |
| `--confirm-jev` | | Required with `MODEL=jev`: every cycle is a paid call (about 2,760 per root per trading day at 30 s). |

**3. Read it.** The console prints net PnL (realized, open, fees), round trips, win rate, profit factor, expectancy, hold time, max drawdown, daily Sharpe (5+ days), gate counts and a buy and hold comparison per root. `data/backtests/<time>/` gets `summary.json`, `trades.csv` (one row per flat-to-flat round trip), `equity.csv` (after every cycle) and `cycles.jsonl` (every decision, as the live `/events` stream).

How the clock works: records are replayed in time order across contracts. Before each record, everything due earlier runs in time order: decision cycles every `decisionSeconds` per root (staggered as live) and orders or cancels reaching the exchange after `latency`. Then the record updates the book, and resting stops trigger on it at that quote, so gaps slip. Status and fill messages are delivered as microtasks and flushed before the clock moves, in the same status-then-fill order as IBKR. Positions are marked at the last quote when the data ends.

What it does not model: queue position (entries are IOCs at the touch, so this matters little; a strategy with resting limits would be optimistic), depth beyond the touch, exchange holidays, and model behavior under real latency (the model answers instantly in replay time; `--latency` stands in for its delay).

## Known limits

- **The simulator is optimistic.** `SimExecution` fills the whole order at the touch, ignores queue position and size, and fills a stop at the touch that triggered it. Treat sim PnL as an upper bound.
- **Backtests are only as good as the ticks.** IBKR's live top of book is sampled, and its historical ticks are stamped to the second. Replay results are a guide to how the loop behaves, not a forecast.
- **A stop that has already triggered at the exchange cannot be cancelled.** If it fills at the same moment as an exit, the position overshoots; the next reconcile adopts the broker's position and the loop trades back to target.
- **Holidays and early closes are not modelled** in session hours. Trading on a holiday session just finds no quote, or IBKR rejects the order.
- **Features for rates.** For ZB the book and price-path features are thin; the economic calendar (CPI, NFP, FOMC, auctions) and yield/curve context are not in the state yet.
- **The mock model is not a strategy.** Nothing here has been shown to make money. Jev's futures questions are a first draft.
