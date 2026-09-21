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
| session closed | do nothing |
| within `FUT_ENTRY_CUTOFF_MIN` of the daily close, spread over `FUT_MAX_SPREAD_TICKS`, delayed data with real orders, feed down | exits only |
| `FUT_MAX_CONTRACTS` | cap |

6. If the target differs from the position and nothing is in flight: one IOC limit at the touch (plus `FUT_SLIP_TICKS`) for the difference. A flip is one order. Orders that reduce the position pull the stop first so both cannot fill.
7. Keep exactly one GTC stop covering the whole position, `FUT_STOP_TICKS_<ROOT>` from the average entry. It lives at the broker, so it protects the position if this process dies.

Position and PnL come from fills (with real commissions on IBKR). An order counts as settled only when its final status and all its fills have arrived, since IBKR sends them separately and in either order. Every cycle is written to `data/futures-events.jsonl` and streamed on `/events`.

## Running

    bun run test:futures                        # 30 tests, no broker needed
    FUT_ROOTS=MES,MNQ,ZB bun run futures        # sim: real quotes, simulated fills
    FUT_EXEC=ibkr bun run futures               # orders to the IBKR paper account on IB_PORT
    MODEL=jev TYPESAFE_AI_API_KEY=... bun run futures   # Jev instead of the mock

Before `FUT_EXEC=ibkr`: use a dedicated paper account (startup cancels every open order on it unless `FUT_CANCEL_ON_START=false`), and run sim for a while first. Real money needs `IB_LIVE=true` and a live port on top of `FUT_EXEC=ibkr`.

## Known limits

- **The simulator is optimistic.** `SimExecution` fills the whole order at the touch, ignores queue position and size, and fills a stop at the touch that triggered it. Treat sim PnL as an upper bound.
- **No backtester yet.** `ManualMarketData` is the seam for replaying recorded quotes through the same loop; there is no historical data loader.
- **A stop that has already triggered at the exchange cannot be cancelled.** If it fills at the same moment as an exit, the position overshoots; the next reconcile adopts the broker's position and the loop trades back to target.
- **Holidays and early closes are not modelled** in session hours. Trading on a holiday session just finds no quote, or IBKR rejects the order.
- **Features for rates.** For ZB the book and price-path features are thin; the economic calendar (CPI, NFP, FOMC, auctions) and yield/curve context are not in the state yet.
- **The mock model is not a strategy.** Nothing here has been shown to make money. Jev's futures questions are a first draft.
