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
HORIZONS = (5, 30, 60, 120, 240)
# Profit target and stop for the cost-aware (triple barrier) label: one expected move over the horizon,
# from recent volatility, so the labels mean the same thing in a quiet 2019 and a fast 2025. Floored so the
# target always clears the round trip cost several times over.
BARRIER_SIGMA = 1.0
MIN_BARRIER_TICKS = {"ES": 8, "NQ": 8, "ZB": 4, "GC": 10}

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
    for w in (1, 5, 15, 30, 60, 120, 240, 480):
        out[f"{prefix}ret{w}"] = ret(w)
    # realized volatility: root mean square of 1 minute moves, in ticks
    for w in (15, 60, 240, 1440):
        out[f"{prefix}vol{w}"] = r1.pow(2).rolling(w).mean().pow(0.5)
    out[f"{prefix}volratio"] = out[f"{prefix}vol15"] / out[f"{prefix}vol240"]
    # each move in units of its normal size, so a burst is visibly a burst
    for w in (5, 15, 60):
        out[f"{prefix}sig{w}"] = out[f"{prefix}ret{w}"] / (out[f"{prefix}vol240"] * np.sqrt(w))
    # where price sits in its recent range
    for w in (30, 120, 480):
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

def first_touch(high: np.ndarray, low: np.ndarray, close: np.ndarray, rows: np.ndarray, h: int, b: np.ndarray):
    """
    For each decision bar in `rows`: does price reach close+b or close-b first within the next `h` bars?
    Returns (outcome, exit_ticks, minutes): outcome +1 up first, -1 down first, 0 neither; exit is the move
    in price terms at the barrier or at the horizon. Done in chunks so the forward windows stay in memory.
    """
    n = len(rows)
    outcome = np.zeros(n, np.int8); exitpx = np.full(n, np.nan); mins = np.full(n, np.nan)
    win = np.lib.stride_tricks.sliding_window_view
    H = win(high, h)   # H[i] = high[i : i+h]
    L = win(low, h)
    for s0 in range(0, n, 20_000):
        idx = rows[s0:s0 + 20_000]
        c0 = close[idx][:, None]
        bb = b[s0:s0 + 20_000][:, None]
        hi = np.maximum.accumulate(H[idx + 1], axis=1)   # running high over the next h bars
        lo = np.minimum.accumulate(L[idx + 1], axis=1)
        up_at = np.argmax(hi >= c0 + bb, axis=1); up_hit = (hi[:, -1] >= c0[:, 0] + bb[:, 0])
        dn_at = np.argmax(lo <= c0 - bb, axis=1); dn_hit = (lo[:, -1] <= c0[:, 0] - bb[:, 0])
        up_at = np.where(up_hit, up_at, h + 1); dn_at = np.where(dn_hit, dn_at, h + 1)
        first_up = up_at < dn_at; first_dn = dn_at < up_at
        sl = slice(s0, s0 + len(idx))
        outcome[sl] = np.where(first_up, 1, np.where(first_dn, -1, 0))
        exitpx[sl] = np.where(first_up, c0[:, 0] + bb[:, 0], np.where(first_dn, c0[:, 0] - bb[:, 0], close[np.minimum(idx + h, len(close) - 1)]))
        mins[sl] = np.where(first_up, up_at + 1, np.where(first_dn, dn_at + 1, h))
    return outcome, exitpx, mins


def targets(df: pd.DataFrame, market: str, decision: np.ndarray | None = None) -> pd.DataFrame:
    """Forward looking, over the next w minutes. Windows that span a session break are dropped by `open{w}`."""
    tk = TICK[market]
    c = df["c"]
    # max/min over the NEXT w bars: reverse, roll, reverse, then step one bar forward
    fwd = lambda s, w, how: getattr(s[::-1].rolling(w), how)()[::-1].shift(-1)
    gap = pd.Series(df.index, index=df.index).diff().dt.total_seconds().div(60)
    out = pd.DataFrame(index=df.index)
    for w in HORIZONS:
        out[f"y_move{w}"] = (c.shift(-w) - c) / tk                                   # signed move, ticks
        out[f"y_range{w}"] = (fwd(df["h"], w, "max") - fwd(df["l"], w, "min")) / tk  # high minus low, ticks
        out[f"y_absmove{w}"] = out[f"y_move{w}"].abs()
        out[f"y_open{w}"] = fwd(gap, w, "max") <= 2  # y_ prefix: forward looking, never a feature                                    # no session break inside the window
    # cost-aware outcome: which barrier comes first, and what the trade would have made holding to it
    rows = np.arange(len(df)) if decision is None else decision
    r1 = (df["c"].diff() / tk)
    vol = r1.pow(2).rolling(240).mean().pow(0.5).shift(1).to_numpy()  # known before the decision
    for w in (60, 120, 240):
        keep = rows[(rows + w + 1 < len(df)) & np.isfinite(vol[rows])]
        bticks = np.maximum(BARRIER_SIGMA * vol[keep] * np.sqrt(w), MIN_BARRIER_TICKS[market])
        oc, ex, mn = first_touch(df["h"].to_numpy(), df["l"].to_numpy(), df["c"].to_numpy(), keep, w, bticks * tk)
        for name, vals in [(f"y_hit{w}", oc), (f"y_exit{w}", (ex - df["c"].to_numpy()[keep]) / tk), (f"y_hitmin{w}", mn), (f"y_barrier{w}", bticks)]:
            col = pd.Series(np.nan, index=df.index)
            col.iloc[keep] = vals
            out[name] = col
    return out

def build(market: str) -> pd.DataFrame:
    frames = {m: load(m) for m in FILES}
    own = frames[market]
    X = features(own, market)
    for other in FILES:
        if other == market: continue
        X = X.join(features(frames[other], other, prefix=f"{other}_")[[f"{other}_ret5", f"{other}_ret15", f"{other}_ret60", f"{other}_sig5", f"{other}_sig15", f"{other}_flow5", f"{other}_flow15", f"{other}_vol_vs_normal"]], how="left")
    decision = np.flatnonzero(own.index.minute % STEP == 0)
    X = X.join(clock(own.index)).join(targets(own, market, decision))
    X = X[(X.index.minute % STEP == 0)]
    X = X.dropna(subset=[c for c in X.columns if not c.startswith(("y_", "open"))])
    # a row is usable for a horizon if the market stayed open through it; keep rows open for at least 30 min
    X = X[X["y_open5"].fillna(False) & X["y_open30"].fillna(False)]
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
