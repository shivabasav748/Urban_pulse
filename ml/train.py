"""Urban Pulse demand forecast (PS 02 feature A). Everything here is SIMULATED.

1. Generate 42 days of synthetic demand for 8 Bengaluru zones in 30-min buckets (seed 42).
2. Train HistGradientBoostingRegressor to predict demand 30 minutes ahead.
3. Chronological split: train on days 8-35, test on days 36-42. Compare MAE with seasonal-naive (same time last week).
4. Write supabase/seed_forecast.sql (observations, forecasts, model_runs) and src/sim/forecast.json (12 Nov, all scenarios).

Run: python ml/train.py   (needs numpy, pandas, scikit-learn; see ml/requirements.txt)
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error

SEED = 42
ROOT = Path(__file__).resolve().parents[1]
IST = timezone(timedelta(hours=5, minutes=30))
START = datetime(2026, 10, 2, tzinfo=IST)
DAYS, BPD = 42, 48  # days, 30-min buckets per day
DEMO_DAY = 41       # 0-based index of 12 Nov 2026 (last test day)
VERSION = "hgb-v2-seed42"

ZONES = [  # id, name, kind, base demand per 30 min
    (1, "Koramangala", "mixed", 3.0), (2, "Indiranagar", "nightlife", 2.6), (3, "MG Road", "office", 3.2),
    (4, "HSR Layout", "residential", 2.2), (5, "Whitefield", "office", 2.8), (6, "Electronic City", "office", 2.4),
    (7, "Stadium", "events", 0.8), (8, "Hebbal (Airport Rd)", "transit", 1.6),
]
OFFICE = {3, 5, 6}
INCIDENT_BOOST = {"events": 4.0, "transit": 2.0}


def bump(h, centre, width, height):
    return height * np.exp(-((h - centre) ** 2) / (2 * width**2))


def hour_curve(kind, h):
    """Relative demand by hour-of-day (h is fractional hours). Hand-designed, documented as an assumption."""
    base = 0.25 + bump(h, 13, 4, 0.35)
    shapes = {
        "office": bump(h, 9.25, 1.0, 1.6) + bump(h, 18.5, 1.3, 1.9),
        "nightlife": bump(h, 21.5, 1.8, 1.8) + bump(h, 13.5, 1.5, 0.4),
        "residential": bump(h, 8.25, 1.2, 1.3) + bump(h, 19.5, 1.5, 1.0),
        "mixed": bump(h, 9, 1.2, 0.9) + bump(h, 19.5, 2.0, 1.3),
        "events": bump(h, 19, 2.5, 0.4),
        "transit": bump(h, 6, 1.0, 1.0) + bump(h, 23, 1.2, 0.9),
    }
    return base + shapes[kind]


def generate(rng):
    rows = []
    rainy_day = rng.random(DAYS) < 0.25
    concert_day = rng.random(DAYS) < 0.18
    flight_wave_day = rng.random(DAYS) < 0.35
    for d in range(DAYS):
        day = START + timedelta(days=d)
        weekday_factor = 1.0 if day.weekday() < 5 else 0.8
        for zid, name, kind, base in ZONES:
            zone_rain_day = rainy_day[d] and rng.random() < 0.8
            for b in range(BPD):
                h = b / 2
                rain = int(zone_rain_day and 15 <= h < 21)
                incident = scheduled = 0  # incident: any demand shock; scheduled_event: only the known-in-advance ones
                if kind == "events" and concert_day[d] and 22 <= h < 23:
                    incident = scheduled = 1
                elif kind == "transit" and flight_wave_day[d] and 6 <= h < 7.5:
                    incident = scheduled = 1
                elif kind not in INCIDENT_BOOST and rng.random() < 0.01:
                    incident = 1  # random local incident: unpredictable, NOT a model feature
                wf = weekday_factor if kind != "nightlife" else (1.25 if day.weekday() >= 4 else 1.0)
                mult = (1 + 0.3 * rain) * (INCIDENT_BOOST.get(kind, 1.6) if incident else 1)
                lam = base * hour_curve(kind, h) * wf * mult
                rows.append((zid, d, b, day + timedelta(minutes=30 * b), rain, incident, scheduled, int(rng.poisson(lam))))
    return pd.DataFrame(rows, columns=["zone", "day", "bucket", "ts", "rain", "incident", "scheduled_event", "demand"])


def features(df):
    """One row per (zone, target time). Target = demand 30 min after the latest observation."""
    df = df.sort_values(["zone", "ts"]).copy()
    g = df.groupby("zone")["demand"]
    df["lag1"] = g.shift(1)            # latest observed bucket (30 min before target)
    df["lag48"] = g.shift(48)          # same time yesterday
    df["lag336"] = g.shift(336)        # same time last week (also the naive baseline)
    df["roll4"] = g.shift(1).rolling(4).mean().reset_index(level=0, drop=True)
    df["hour"] = df["bucket"] / 2
    df["dow"] = df["ts"].map(lambda t: t.weekday())
    df["weekend"] = (df["dow"] >= 5).astype(int)
    return df


FEATS = ["zone", "hour", "dow", "weekend", "rain", "scheduled_event", "lag1", "lag48", "lag336", "roll4"]


def fit(df):
    train = df[(df.day >= 8) & (df.day <= 35)]
    test = df[df.day >= 36]
    model = HistGradientBoostingRegressor(
        loss="poisson", max_iter=300, learning_rate=0.06, max_leaf_nodes=31,
        categorical_features=[FEATS.index("zone")], random_state=SEED,
    )
    model.fit(train[FEATS], train["demand"])
    return train, test, model, np.clip(model.predict(test[FEATS]), 0, None)


def main():
    raw = generate(np.random.default_rng(SEED))
    train, test, model, pred = fit(features(raw))
    mae = mean_absolute_error(test["demand"], pred)
    base_mae = mean_absolute_error(test["demand"], test["lag336"])
    print(f"train rows {len(train)}, test rows {len(test)}")
    print(f"MAE model {mae:.3f} | seasonal-naive (same time last week) {base_mae:.3f} | "
          f"improvement {100 * (1 - mae / base_mae):.1f}% | mean demand {test['demand'].mean():.2f}")

    test = test.assign(pred=pred)
    scen = {"base": test.assign(scenario="base", predicted=pred, actual=test["demand"], mv=VERSION)}

    def variant(name, mask, col):  # real model feature flipped on -> re-predict
        x = test.copy()
        x.loc[mask(x), col] = 1
        p = np.clip(model.predict(x[FEATS]), 0, None)
        return x.assign(scenario=name, predicted=p, actual=np.nan, mv=VERSION)

    scen["heavy_rain"] = variant("heavy_rain", lambda x: x.zone.isin([1, 2, 4]) & (x.hour >= 15) & (x.hour < 21), "rain")
    scen["concert_end"] = variant("concert_end", lambda x: (x.zone == 7) & (x.hour >= 22) & (x.hour < 23), "scheduled_event")
    scen["airport_wave"] = variant("airport_wave", lambda x: (x.zone == 8) & (x.hour >= 6) & (x.hour < 7.5), "scheduled_event")
    # rush hour is NOT a model feature: deterministic x1.6 adjustment, labelled in model_version
    rush = test.copy()
    rush_mask = rush.zone.isin(OFFICE) & (rush.hour >= 17.5) & (rush.hour < 19.5)
    scen["rush_hour"] = rush.assign(scenario="rush_hour", predicted=np.where(rush_mask, pred * 1.6, pred),
                                    actual=np.nan, mv="adjustment:x1.6-office-17:30-19:30")
    allf = pd.concat(scen.values())

    # ---- seed SQL ----
    out = ROOT / "supabase" / "seed_forecast.sql"
    with out.open("w", encoding="utf-8") as f:
        f.write("-- GENERATED by ml/train.py. SIMULATED data. Do not edit by hand.\n")
        obs = [f"({r.zone},'{r.ts.isoformat()}',{r.demand},{bool(r.rain)},{bool(r.incident)})" for r in raw.itertuples()]
        for i in range(0, len(obs), 2000):
            f.write("insert into public.demand_observations(zone_id,ts,demand,rain,incident) values\n"
                    + ",\n".join(obs[i:i + 2000]) + ";\n")
        fc = [f"({r.zone},'{(r.ts).isoformat()}','{r.scenario}',{r.predicted:.3f},"
              f"{'null' if pd.isna(r.actual) else int(r.actual)},'{r.mv}')" for r in allf.itertuples()]
        for i in range(0, len(fc), 2000):
            f.write("insert into public.demand_forecasts(zone_id,target_ts,scenario,predicted,actual,model_version) values\n"
                    + ",\n".join(fc[i:i + 2000]) + ";\n")
        f.write("insert into public.model_runs values ('%s','HistGradientBoostingRegressor(loss=poisson)',%.4f,%.4f,'%s',%d,%d,30,now());\n"
                % (VERSION, mae, base_mae, json.dumps(FEATS), len(train), len(test)))

    # ---- arena JSON: demo day, all scenarios, per zone x 48 buckets ----
    day = allf[allf.day == DEMO_DAY]
    js = {
        "simulated": True, "date": "2026-11-12", "bucket_min": 30, "model_version": VERSION,
        "mae": round(mae, 4), "baseline_mae": round(base_mae, 4), "horizon_min": 30, "features": FEATS,
        "zones": [{"id": z, "name": n, "kind": k} for z, n, k, _ in ZONES],
        "scenarios": {s: {str(z): [round(float(v), 3) for v in day[(day.scenario == s) & (day.zone == z)].sort_values("bucket").predicted]
                          for z, *_ in ZONES} for s in scen},
        "actual": {str(z): [int(v) for v in day[(day.scenario == "base") & (day.zone == z)].sort_values("bucket").actual]
                   for z, *_ in ZONES},
    }
    (ROOT / "src" / "sim").mkdir(parents=True, exist_ok=True)
    (ROOT / "src" / "sim" / "forecast.json").write_text(json.dumps(js), encoding="utf-8")
    (ROOT / "ml" / "metrics.json").write_text(json.dumps(
        {k: js[k] for k in ("model_version", "mae", "baseline_mae", "horizon_min", "features")}
        | {"improvement_pct": round(100 * (1 - mae / base_mae), 1), "train_rows": len(train), "test_rows": len(test)}, indent=2))
    print(f"wrote {out.relative_to(ROOT)}, src/sim/forecast.json, ml/metrics.json")


if __name__ == "__main__":
    main()
