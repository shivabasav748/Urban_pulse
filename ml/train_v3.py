"""Train + evaluate the v3 demand model on the synthetic v3 dataset (SIMULATED). v1 and v2 are untouched.

Time-aware split (no shuffling): train = days 28..300, validation = 301..336 (early-stopping only), test = 337..364.
Target: demand in bucket t. Predictors only use information available 30 min earlier (lags from t-1 and older) plus
calendar/scheduled features known in advance (hour, day type, holiday/festival flags, scheduled events) and rain
(assumed available from a 30-min weather nowcast; a documented assumption).
Baselines: seasonal-naive (same time last week), same time yesterday, recent average (mean of the same bucket over the
previous 4 weeks), last value (t-1).
Run: python ml/train_v3.py   (after ml/generate_v3.py). Writes ml/metrics_v3.json.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "v3" / "demand_v3.csv"
VERSION = "hgb-v3-seed20261113"
FEATS = ["zone_id", "hour", "dow", "weekend", "holiday", "festival", "rain", "scheduled_event", "month",
         "lag1", "lag2", "lag48", "lag336", "roll4", "same_bucket_avg4w"]


def features(df):
    df = df.sort_values(["zone_id", "ts"]).copy()
    g = df.groupby("zone_id")["demand"]
    df["lag1"], df["lag2"], df["lag48"], df["lag336"] = g.shift(1), g.shift(2), g.shift(48), g.shift(336)
    df["roll4"] = g.transform(lambda s: s.shift(1).rolling(4).mean())          # grouped: never mixes zones
    df["same_bucket_avg4w"] = (df.groupby(["zone_id", "bucket"])["demand"]
                               .transform(lambda s: s.shift(1).rolling(28).mean()))  # previous 28 days, same bucket
    df["hour"] = df["bucket"] / 2
    df["month"] = pd.to_datetime(df["ts"], utc=True).dt.tz_convert("Asia/Kolkata").dt.month
    return df


def metrics(y, p):
    y, p = np.asarray(y, float), np.asarray(p, float)
    nz = y > 0
    return {"n": int(len(y)), "mae": round(float(np.mean(np.abs(y - p))), 4), "rmse": round(float(np.sqrt(np.mean((y - p) ** 2))), 4),
            "mape_nonzero_pct": round(float(np.mean(np.abs(y[nz] - p[nz]) / y[nz]) * 100), 2) if nz.any() else None,
            "wape_pct": round(float(np.sum(np.abs(y - p)) / max(np.sum(y), 1e-9) * 100), 2),
            "bias": round(float(np.mean(p - y)), 4), "mean_actual": round(float(y.mean()), 4)}


def main():
    df = features(pd.read_csv(DATA))
    train = df[(df.day >= 28) & (df.day <= 300)].dropna(subset=FEATS)
    val = df[(df.day > 300) & (df.day <= 336)].dropna(subset=FEATS)
    test = df[df.day > 336].dropna(subset=FEATS)
    assert train.ts.max() < val.ts.min() and val.ts.max() < test.ts.min(), "split must be chronological"
    # model selection: the validation window picks max_iter; the test window is used once, at the end
    best, best_mae, best_it = None, 1e9, None
    for it in (150, 250, 400):
        m = HistGradientBoostingRegressor(loss="poisson", max_iter=it, learning_rate=0.05, max_leaf_nodes=31,
                                          categorical_features=[FEATS.index("zone_id")], random_state=20261113)
        m.fit(train[FEATS], train["demand"])
        v = float(np.mean(np.abs(val["demand"] - np.clip(m.predict(val[FEATS]), 0, None))))
        if v < best_mae: best, best_mae, best_it = m, v, it
    model = best
    pred = np.clip(model.predict(test[FEATS]), 0, None)
    t = test.assign(pred=pred)
    base = {"seasonal_naive_lag336": t["lag336"], "same_time_yesterday_lag48": t["lag48"],
            "recent_avg_same_bucket_4w": t["same_bucket_avg4w"], "last_value_lag1": t["lag1"]}
    out = {"model_version": VERSION, "synthetic": True, "dataset": "synthetic-demand-v3", "horizon_min": 30,
           "split_days": {"train": [28, 300], "validation": [301, 336], "test": [337, 364]},
           "rows": {"train": len(train), "validation": len(val), "test": len(test)}, "max_iter_selected": best_it,
           "features": FEATS, "overall": {"model": metrics(t.demand, t.pred), **{k: metrics(t.demand, v) for k, v in base.items()}}}
    peak = t.hour.between(8, 10) | t.hour.between(17, 20)
    out["by_period"] = {"peak (08-10, 17-20)": metrics(t[peak].demand, t[peak].pred), "off_peak": metrics(t[~peak].demand, t[~peak].pred)}
    out["by_day_type"] = {k: metrics(t[m].demand, t[m].pred) for k, m in
                          {"weekday": (t.weekend == 0) & (t.holiday == 0) & (t.festival == 0), "weekend": t.weekend == 1,
                           "holiday_or_festival": (t.holiday == 1) | (t.festival == 1)}.items() if m.any()}
    ev = t.scheduled_event == 1
    out["scheduled_event_buckets"] = {"model": metrics(t[ev].demand, t[ev].pred), "seasonal_naive": metrics(t[ev].demand, t[ev].lag336)} if ev.any() else None
    rn = t.rain == 1
    out["rain_buckets"] = {"model": metrics(t[rn].demand, t[rn].pred), "seasonal_naive": metrics(t[rn].demand, t[rn].lag336)} if rn.any() else None
    out["by_zone"] = {str(z): {"model": metrics(g.demand, g.pred), "seasonal_naive": metrics(g.demand, g.lag336)} for z, g in t.groupby("zone_id")}
    (ROOT / "metrics_v3.json").write_text(json.dumps(out, indent=2))
    o = out["overall"]
    print(f"test rows {len(test)} | model MAE {o['model']['mae']} RMSE {o['model']['rmse']} bias {o['model']['bias']}")
    for k in base: print(f"  baseline {k}: MAE {o[k]['mae']} RMSE {o[k]['rmse']}")
    print("peak", out["by_period"]["peak (08-10, 17-20)"]["mae"], "off", out["by_period"]["off_peak"]["mae"],
          "| events", out["scheduled_event_buckets"]["model"]["mae"] if out["scheduled_event_buckets"] else None)


if __name__ == "__main__":
    main()
