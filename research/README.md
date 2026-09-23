# Research: can anything predict these markets?

Supervised learning on the Sierra Chart 1 minute exports in `histdata/` (ES, NQ, ZB, GC; 2019 to date; open,
high, low, close, volume, trade count, and bid and ask volume, which gives aggressive buy and sell flow).
Kept apart from the live bot: nothing here runs in trading.

```bash
python3 research/dataset.py ES          # build data/research/ES.parquet (a row every 5 minutes)
python3 research/train.py ES move       # how much will it move in the next 30 minutes
python3 research/train.py ES direction  # which way, against the cost of trading
python3 research/train.py ES filtered   # direction, but only when a big move is expected
python3 research/train.py ES long       # 1 to 4 hour horizons, cost-aware (profit target, stop, timeout)
```

Rules that keep the results honest:

- every feature uses bars strictly before its decision minute, and the targets look forward;
- windows that span the daily break are dropped;
- walk forward: train on 2019 to a year, test on the year after, never the reverse;
- each result is measured against a baseline worth beating (recent volatility for move size, the cost of a
  round trip for direction).

## Results so far (ES, 463k decision points)

| Question | Result |
|---|---|
| How much will it move in the next 30 minutes? | Rank correlation 0.80 to 0.86 on unseen years, against 0.62 to 0.67 for recent volatility. Error about 30% below that baseline. **Predictable.** |
| Which way in the next 5 or 30 minutes? | AUC 0.50 to 0.51, hit rate 50 to 52%, negative Brier skill. Strong calls captured less than the roughly 2 tick cost in most years. **Not predictable.** |
| Direction when a big move is expected | No consistent pattern: helps in 2025, hurts in 2024, mixed in 2026. **Noise.** |

### Longer horizons with a cost-aware target (ES, NQ, ZB, GC)

Each trade is held to a profit target or stop one expected move away (from recent volatility, so the labels
mean the same in 2019 and 2025) or to the horizon. The model predicts what the trade would make in ticks;
trades are then simulated in time order and never overlap, so the counts are tradable.

| Market | 60 min | 120 min | 240 min |
|---|---|---|---|
| ES | −0.3 to −3.0 ticks a trade, every year | −2.7 to +1.7, mostly negative | −3.4 to +0.1 |
| NQ | mixed, −0.5 to +2.8 | **+1.1 to +4.7, positive every year** | −2.2 to +21.6 |
| ZB | negative except a few tiny samples | −1.3 to +0.7 | −2.4 to −0.7, all negative |
| GC | −0.8 to −3.0, all negative | all negative | all negative |

NQ is the only one that is not clearly negative, and it does not survive scrutiny: the model is long 54 to
61% of the time, and simply always going long made +1.30, +2.74 and +0.15 ticks in those years, so most of
the result is the market's rise. What is left is about 1 to 2 ticks a trade with t below 1.2, while a coin
flip in the same test made between +0.58 and −7.78. That is noise, not an edge.

This matches what the live Jev bot showed: direction is a coin flip at every horizon tested, while the size of
the coming move is not.
