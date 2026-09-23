"""
Build a training table from the Sierra Chart 1 minute exports in histdata/.

One row per decision point (every STEP minutes the market is open), for one market. Every feature uses only
bars strictly before that minute; the targets look forward. Cross-market features come from the other
contracts at the same minute, which is how ES, NQ, ZB and GC lead and lag each other.

    python research/dataset.py ES --out data/research/ES.parquet
"""
import argparse, pathlib, sys
import numpy as np, pandas as pd

HIST = pathlib.Path(__file__).resolve().parent.parent / "histdata"
FILES = {"ES": "ESZ26-CME", "NQ": "NQZ26-CME", "ZB": "ZBZ26-CBOT", "GC": "GCZ26-COMEX"}
TICK = {"ES": 0.25, "NQ": 0.25, "ZB": 1 / 32, "GC": 0.1}
STEP = 5          # a decision every 5 minutes
BREAK_MIN = 60    # the daily close to reopen break, in minutes

def load(market: str) -> pd.DataFrame:
    f = HIST / f"{FILES[market]}.scid_BarData_1M.txt"
    df = pd.read_csv(f, skipinitialspace=True, engine="c")
    df.columns = [c.strip() for c in df.columns]
    ts = pd.to_datetime(df.pop("Date").str.strip() + " " + df.pop("Time").str.strip(), format="%Y/%m/%d %H:%M:%S")
    df = df.set_axis(ts).rename(columns={"Last": "c", "Open": "o", "High": "h", "Low": "l", "Volume": "v",
                                         "NumberOfTrades": "n", "BidVolume": "bv", "AskVolume": "av"})
    return df.astype(np.float64).sort_index()

def features(df: pd.DataFrame, market: str, prefix: str = "") -> pd.DataFrame:
    """Everything here is known at the close of the previous minute."""
    tk = TICK[market]
    c = df["c"]
    out = pd.DataFrame(index=df.index)
    ret = lambda w: (c - c.shift(w)) / tk                      # move in ticks over w minutes
    r1 = ret(1)
    for w in (1, 5, 15, 30, 60, 120):
        out[f"{prefix}ret{w}"] = ret(w)
    # realized volatility: root mean square of 1 minute moves, in ticks
    for w in (15, 60, 240):
        out[f"{prefix}vol{w}"] = r1.pow(2).rolling(w).mean().pow(0.5)
    out[f"{prefix}volratio"] = out[f"{prefix}vol15"] / out[f"{prefix}vol240"]
    # each move in units of its normal size, so a burst is visibly a burst
    for w in (5, 15, 60):
        out[f"{prefix}sig{w}"] = out[f"{prefix}ret{w}"] / (out[f"{prefix}vol240"] * np.sqrt(w))
    # where price sits in its recent range
    for w in (30, 120):
        hi, lo = df["h"].rolling(w).max(), df["l"].rolling(w).min()
        out[f"{prefix}pos{w}"] = (c - lo) / (hi - lo).replace(0, np.nan)
        out[f"{prefix}width{w}"] = (hi - lo) / tk
    # order flow: aggressive buying minus selling as a share of volume
    for w in (5, 15, 60):
        vol = df["v"].rolling(w).sum()
        out[f"{prefix}flow{w}"] = (df["av"].rolling(w).sum() - df["bv"].rolling(w).sum()) / vol.replace(0, np.nan)
        out[f"{prefix}vpertrade{w}"] = vol / df["n"].rolling(w).sum().replace(0, np.nan)
    # activity against the same time of day over the last 20 sessions
    tod = df.index.hour * 60 + df.index.minute
    v5 = df["v"].rolling(5).sum()
    normal = v5.groupby(tod).transform(lambda s: s.shift(1).rolling(20, min_periods=5).mean())
    out[f"{prefix}vol_vs_normal"] = v5 / normal.replace(0, np.nan)
    return out.shift(1)  # strictly before the decision minute

def clock(idx: pd.DatetimeIndex) -> pd.DataFrame:
    tod = idx.hour * 60 + idx.minute
    chicago = (idx.tz_localize("UTC").tz_convert("America/Chicago"))
    cash = ((chicago.hour * 60 + chicago.minute) >= 8 * 60 + 30) & ((chicago.hour * 60 + chicago.minute) < 15 * 60) & (chicago.dayofweek < 5)
    out = pd.DataFrame(index=idx)
    out["tod_sin"] = np.sin(2 * np.pi * tod / 1440)
    out["tod_cos"] = np.cos(2 * np.pi * tod / 1440)
    out["dow"] = idx.dayofweek
    out["cash"] = cash.astype(int)
    out["mins_from_cash_open"] = (chicago.hour * 60 + chicago.minute) - (8 * 60 + 30)
    return out

def targets(df: pd.DataFrame, market: str) -> pd.DataFrame:
    """Forward looking, over the next w minutes. Windows that span a session break are dropped by `open{w}`."""
    tk = TICK[market]
    c = df["c"]
    # max/min over the NEXT w bars: reverse, roll, reverse, then step one bar forward
    fwd = lambda s, w, how: getattr(s[::-1].rolling(w), how)()[::-1].shift(-1)
    gap = pd.Series(df.index, index=df.index).diff().dt.total_seconds().div(60)
    out = pd.DataFrame(index=df.index)
    for w in (5, 30):
        out[f"y_move{w}"] = (c.shift(-w) - c) / tk                                   # signed move, ticks
        out[f"y_range{w}"] = (fwd(df["h"], w, "max") - fwd(df["l"], w, "min")) / tk  # high minus low, ticks
        out[f"y_absmove{w}"] = out[f"y_move{w}"].abs()
        out[f"open{w}"] = fwd(gap, w, "max") <= 2                                    # no session break inside the window
    return out

def build(market: str) -> pd.DataFrame:
    frames = {m: load(m) for m in FILES}
    own = frames[market]
    X = features(own, market)
    for other in FILES:
        if other == market: continue
        X = X.join(features(frames[other], other, prefix=f"{other}_")[[f"{other}_ret5", f"{other}_ret15", f"{other}_ret60", f"{other}_sig5", f"{other}_sig15", f"{other}_flow5", f"{other}_flow15", f"{other}_vol_vs_normal"]], how="left")
    X = X.join(clock(own.index)).join(targets(own, market))
    X = X[(X.index.minute % STEP == 0)]
    X = X.dropna(subset=[c for c in X.columns if not c.startswith(("y_", "open"))])
    X = X[X["open5"].fillna(False) & X["open30"].fillna(False)].drop(columns=["open5", "open30"])
    X = X.dropna(subset=["y_move5", "y_move30"])
    return X

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("market", choices=list(FILES))
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    df = build(a.market)
    out = pathlib.Path(a.out or f"data/research/{a.market}.parquet")
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out)
    print(f"{a.market}: {len(df):,} rows, {len([c for c in df.columns if not c.startswith('y_')])} features, "
          f"{df.index.min()} to {df.index.max()} -> {out}", file=sys.stderr)
