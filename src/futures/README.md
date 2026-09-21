# Futures adapters (MES, MNQ, ZB on IBKR)

A sketch of what the Monad/Kuru loop needs in order to trade listed futures through Interactive Brokers. It is not wired into `src/trader.ts` yet and places no orders on its own. The Monad bot is unchanged.

## Layout

    types.ts            ContractSpec, MarketData, Execution and the shared types. Venue neutral.
    contracts.ts        MES, MNQ, ZB specs: tick, multiplier, cycle, expiry / first notice / roll calendar,
                        Globex session, tick math, 32nds formatting for ZB
    contracts.test.ts   calendar, session and tick math tests (bun test src/futures)
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

## Not built yet

- **A futures trader loop.** `src/trader.ts` is block-driven and assumes spot inventory. A futures loop should run on a timer or on bar close, read `md.book()`, build a futures `TradeState`, call the same `Model`, check risk, then `ex.place`. Position and PnL come from `ExecFill` using `pnlUsd`, and are checked against `ex.positions()` on startup and after reconnects.
- **A risk gate** in front of `place`: max contracts per root, max daily loss, no new positions outside `session.isOpen` or after `rollDate`, flatten ahead of ZB first notice, `whatIf` margin check before adding.
- **A backtester** with queue-aware fills. Joining a one-tick-wide ES/NQ/ZB book puts the order at the back of a deep queue, so "filled when a print touches our price" (the Monad dry-run rule) overstates fills badly.
- **Features for rates.** For ZB the MON-USDC book features are not enough on their own; add the economic calendar (CPI, NFP, FOMC, auctions) and yield/curve context.

The Monad strategy (cancel and repost every 300 ms, one tick inside the touch) should not be ported as-is: there is no inside on a one-tick market, hosted-model latency loses to co-located makers, and constant cancel/replace draws CME messaging and disruptive-practice (Rule 575) scrutiny. Decide on a cadence of seconds to minutes and prefer resting orders that are left alone, or marketable orders with brackets.
