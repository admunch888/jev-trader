# Research: can anything predict these markets?

Supervised learning on the Sierra Chart 1 minute exports in `histdata/` (ES, NQ, ZB, GC; 2019 to date; open,
high, low, close, volume, trade count, and bid and ask volume, which gives aggressive buy and sell flow).
Kept apart from the live bot: nothing here runs in trading.

```bash
python3 research/dataset.py ES          # build data/research/ES.parquet (a row every 5 minutes)
python3 research/train.py ES move       # how much will it move in the next 30 minutes
python3 research/train.py ES direction  # which way, against the cost of trading
python3 research/train.py ES filtered   # direction, but only when a big move is expected
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

This matches what the live Jev bot showed: direction at a 5 minute horizon is a coin flip, while the size of
the coming move is not.
