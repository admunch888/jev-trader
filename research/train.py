"""
Walk-forward tests on the table dataset.py builds. Nothing is ever trained on data that comes after its test
period, and each test year is untouched until it is tested.

    python research/train.py ES move      how much will it move in the next 30 minutes (size, not direction)
    python research/train.py ES direction which way over the next 5 and 30 minutes, against the cost of trading
"""
import argparse, sys
import numpy as np, pandas as pd, lightgbm as lgb
from scipy.stats import spearmanr

COST_TICKS = {"ES": 2.0, "NQ": 2.0, "ZB": 1.1, "GC": 2.0}  # spread plus fees, a round trip
FOLDS = [(2019, 2023, 2024), (2019, 2024, 2025), (2019, 2025, 2026)]  # train from, train to (inclusive), test year

def load(market):
    df = pd.read_parquet(f"data/research/{market}.parquet")
    feats = [c for c in df.columns if not c.startswith("y_")]
    return df, feats

def folds(df):
    for a, b, test in FOLDS:
        tr = df[(df.index.year >= a) & (df.index.year <= b)]
        # leave a day between train and test so no forward window straddles the split
        te = df[df.index.year == test]
        yield test, tr, te

def fit(tr, te, feats, y, objective, **kw):
    m = lgb.train({"objective": objective, "learning_rate": 0.05, "num_leaves": 63, "min_data_in_leaf": 200,
                   "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1, "verbose": -1, "num_threads": 0, **kw},
                  lgb.Dataset(tr[feats], label=y(tr)), num_boost_round=400)
    return m, m.predict(te[feats])

def move(market):
    df, feats = load(market)
    print(f"\n{market}: how much will it move in the next 30 minutes? (target: high minus low, in ticks)")
    print(f"{'test year':>10} {'rows':>8} {'model corr':>11} {'persistence':>12} {'model MAE':>10} {'persist MAE':>12} {'always-average MAE':>19}")
    for year, tr, te in folds(df):
        y = lambda d: np.log1p(d["y_range30"])
        m, pred = fit(tr, te, feats, y, "regression")
        pred = np.expm1(pred)
        # baseline 1: recent volatility scaled the same way (what a trader would eyeball)
        k = (tr["y_range30"] / (tr["vol240"] * np.sqrt(30))).median()
        persist = te["vol240"] * np.sqrt(30) * k
        actual = te["y_range30"]
        mae = lambda p: float(np.abs(actual - p).mean())
        print(f"{year:>10} {len(te):>8,} {spearmanr(pred, actual).statistic:>11.3f} {spearmanr(persist, actual).statistic:>12.3f} "
              f"{mae(pred):>10.1f} {mae(persist):>12.1f} {mae(tr['y_range30'].mean()):>19.1f}")

def direction(market):
    df, feats = load(market)
    cost = COST_TICKS[market]
    for horizon in (5, 30):
        col = f"y_move{horizon}"
        print(f"\n{market}: which way over the next {horizon} minutes? (cost to beat: {cost} ticks a round trip)")
        print(f"{'test year':>10} {'rows':>8} {'hit rate':>9} {'AUC':>7} {'Brier skill':>12} {'slope':>7} "
              f"{'strong calls':>13} {'ticks captured':>15} {'after cost':>11}")
        for year, tr, te in folds(df):
            tr2 = tr[tr[col] != 0]
            y = lambda d: (d[col] > 0).astype(int)
            m, p = fit(tr2, te, feats, y, "binary")
            moved = te[col] != 0
            up = (te[col] > 0).astype(int)
            base = float(up[moved].mean())
            brier = float(((p[moved.values] - up[moved]) ** 2).mean())
            skill = 1 - brier / (base * (1 - base))
            hit = float(((p[moved.values] > 0.5) == (up[moved] == 1)).mean())
            try:
                from sklearn.metrics import roc_auc_score
                auc = roc_auc_score(up[moved], p[moved.values])
            except Exception:
                auc = float("nan")
            # calibration slope: logistic fit of outcome on the log-odds of the prediction
            lo = np.log(np.clip(p[moved.values], 1e-6, 1 - 1e-6) / (1 - np.clip(p[moved.values], 1e-6, 1 - 1e-6)))
            slope = np.polyfit(lo, up[moved], 1)[0] * 4  # rough: 4 * d(prob)/d(logit) at the middle
            strong = (p > 0.65) | (p < 0.35)
            got = float((np.sign(p[strong] - 0.5) * te[col][strong]).mean()) if strong.any() else float("nan")
            print(f"{year:>10} {len(te):>8,} {hit:>8.1%} {auc:>7.3f} {skill:>12.3f} {slope:>7.2f} "
                  f"{int(strong.sum()):>13,} {got:>15.2f} {got - cost:>11.2f}")

def filtered(market):
    """Direction, but only where the move-size model expects a move worth trading. Both models are trained on the
    same past data as before; the filter is applied to the test year only."""
    df, feats = load(market)
    cost = COST_TICKS[market]
    for horizon in (5, 30):
        col = f"y_move{horizon}"
        print(f"\n{market}: {horizon} minute direction, filtered by predicted move size (cost {cost} ticks)")
        print(f"{'test year':>10} {'kept':>22} {'calls':>8} {'hit rate':>9} {'ticks captured':>15} {'after cost':>11}")
        for year, tr, te in folds(df):
            _, size = fit(tr, te, feats, lambda d: np.log1p(d[f"y_range{horizon}"]), "regression")
            size = np.expm1(size)
            tr2 = tr[tr[col] != 0]
            _, p = fit(tr2, te, feats, lambda d: (d[col] > 0).astype(int), "binary")
            for label, keep in [("everything", np.ones(len(te), bool)),
                                ("top half by size", size >= np.quantile(size, 0.5)),
                                ("top quarter by size", size >= np.quantile(size, 0.75)),
                                ("top tenth by size", size >= np.quantile(size, 0.9))]:
                sel = keep & ((p > 0.6) | (p < 0.4))
                if sel.sum() < 20: continue
                got = float((np.sign(p[sel] - 0.5) * te[col][sel]).mean())
                hit = float(((p[sel] > 0.5) == (te[col][sel] > 0)).mean())
                print(f"{year:>10} {label:>22} {int(sel.sum()):>8,} {hit:>8.1%} {got:>15.2f} {got - cost:>11.2f}")

def long(market):
    """
    Longer horizons with a cost-aware target: what would a trade actually make, held to a profit target, a stop
    (both one expected move away) or the horizon? The model predicts that number in ticks; trades are then
    simulated in time order, never overlapping, so the count is what could really have been traded.
    """
    df, feats = load(market)
    cost = COST_TICKS[market]
    for h in (60, 120, 240):
        col, hitmin = f"y_exit{h}", f"y_hitmin{h}"
        d = df.dropna(subset=[col])
        print(f"\n{market}: {h} minute horizon, profit target and stop one expected move away "
              f"(median {d[f'y_barrier{h}'].median():.0f} ticks), cost {cost} ticks a trade")
        print(f"{'test year':>10} {'enter when predicted >':>23} {'trades':>7} {'won':>6} {'ticks/trade':>12} {'total ticks':>12} {'t':>6}")
        for year, tr, te in folds(d):
            m, pred = fit(tr, te, feats, lambda x: x[col].clip(-3 * x[f"y_barrier{h}"], 3 * x[f"y_barrier{h}"]), "regression")
            for thr in (cost, 2 * cost, 4 * cost):
                # walk forward in time, one trade at a time
                nets, free_from = [], pd.Timestamp.min
                for ts, p, exit_ticks, held in zip(te.index, pred, te[col].to_numpy(), te[hitmin].to_numpy()):
                    if ts < free_from or abs(p) < thr: continue
                    nets.append(np.sign(p) * exit_ticks - cost)
                    free_from = ts + pd.Timedelta(minutes=float(held))
                if len(nets) < 10: continue
                a = np.array(nets)
                t = a.mean() / (a.std(ddof=1) / np.sqrt(len(a)))
                print(f"{year:>10} {thr:>23.1f} {len(a):>7,} {(a > 0).mean():>5.0%} {a.mean():>12.2f} {a.sum():>12,.0f} {t:>6.2f}")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("market"); ap.add_argument("task", choices=["move", "direction", "filtered", "long"])
    a = ap.parse_args()
    {"move": move, "direction": direction, "filtered": filtered, "long": long}[a.task](a.market)
