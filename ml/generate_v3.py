"""Urban Pulse synthetic demand dataset v3 (SIMULATED, deterministic). Not real Belagavi passenger data.

365 days x 8 zones x 48 half-hour buckets = 140,160 zone-interval observations (13 Nov 2025 - 12 Nov 2026, IST),
plus an hour-dependent zone-to-zone destination-share matrix. Every row carries provenance columns.

Design (all assumptions documented in docs/DEMO_DATA_SPECIFICATION.md):
* demand ~ Poisson(lambda), lambda = base_zone x daily_profile(zone purposes, day type) x season x weather x scenario shocks
  x latent(zone, t), where latent is an AR(1) log-normal process (adjacent buckets correlated, phi = 0.85) on top of a
  day-level AR(1) zone effect (phi = 0.7): demand persists and recovers instead of being independent noise.
* zone purposes are mixes of commute / lunch-shopping / college / hospital / station / airport / nightlife / events,
  chosen from what each zone contains in OpenStreetMap (e.g. KLE hospital + college in zone 3, VTU in zone 6,
  railway station between zones 1 and 2, Belagavi airport in zone 8). Weights are assumptions, not measurements.
* rain: monsoon-season probability (Jun-Sep high, Oct-Nov medium, Dec-May low) with day-to-day persistence (Markov).
* festivals / public holidays / events / flight waves are SYNTHETIC scenario days drawn from the seed; they are not the
  real calendar, attendance or flight schedule. Event shocks decay over the following buckets (recovery period).
Run: python ml/generate_v3.py [--out ml/data/v3]   (numpy + pandas only)
"""
import argparse
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 20261113
VERSION = "synthetic-demand-v3"
IST = timezone(timedelta(hours=5, minutes=30))
START = datetime(2025, 11, 13, tzinfo=IST)
DAYS, BPD = 365, 48

# zone id, name, base requests per 30 min at profile 1.0, purpose mix (weights sum ~1)
ZONES = [
    (1, "Khade Bazar / City Centre", 2.6, {"market": .45, "commute": .2, "station": .2, "lunch": .15}),
    (2, "Tilakwadi / RPD", 2.3, {"nightlife": .35, "station": .25, "college": .2, "residential": .2}),
    (3, "Nehru Nagar / KLE", 2.8, {"hospital": .4, "college": .3, "commute": .3}),
    (4, "Vadgaon / Shahapur", 1.9, {"residential": .7, "market": .3}),
    (5, "Udyambag Industrial", 2.4, {"industrial": .8, "commute": .2}),
    (6, "VTU / Machhe", 1.8, {"college": .6, "industrial": .4}),
    (7, "KSCA Stadium / Ramteerth Nagar", 0.9, {"residential": .7, "events": .3}),
    (8, "Belagavi Airport (Sambra)", 0.9, {"airport": 1.0}),
]
NEIGHBOURS = {1: [2, 3, 4], 2: [1, 4, 5], 3: [1, 7], 4: [1, 2, 5], 5: [2, 4, 6], 6: [5], 7: [3, 1], 8: [1, 7]}


def bump(h, c, w, a):
    return a * np.exp(-((h - c) ** 2) / (2 * w * w))


def purpose_curve(p, h, workday):
    """Relative intensity by hour for one trip purpose. Hand-designed assumption curves (peak ~1.5-2)."""
    if p == "commute":
        return 0.15 + (bump(h, 8.75, 1.0, 1.7) + bump(h, 18.25, 1.2, 1.9) if workday else bump(h, 11, 3, 0.6) + bump(h, 18, 2.5, 0.6))
    if p == "industrial":  # shift changes ~6, 14, 22 + office hours on workdays
        return 0.1 + (bump(h, 6.25, .6, 1.2) + bump(h, 14.25, .6, 1.3) + bump(h, 22.25, .6, .9) + bump(h, 9, 1, .8) + bump(h, 17.75, 1, .9)) * (1 if workday else .45)
    if p == "college":
        return 0.08 + (bump(h, 8.5, .8, 1.8) + bump(h, 13.5, 1, .7) + bump(h, 16.5, 1, 1.5) if workday else bump(h, 17, 3, .4))
    if p == "hospital":  # visiting hours + steady base, similar every day
        return 0.35 + bump(h, 10.5, 1.8, 1.0) + bump(h, 17.5, 1.5, 0.8)
    if p == "market":
        return 0.12 + bump(h, 11.5, 1.8, 0.9) + bump(h, 18.5, 2.0, 1.4 if workday else 1.8)
    if p == "lunch":
        return 0.1 + bump(h, 13.25, 1.0, 1.3) + bump(h, 20.5, 1.3, 0.8)
    if p == "station":  # assumption: arrival/departure clusters morning, afternoon, late evening
        return 0.15 + bump(h, 5.75, .9, 1.4) + bump(h, 14.5, 1.2, .7) + bump(h, 21.5, 1.3, 1.2)
    if p == "airport":  # synthetic daily wave pattern; real flight schedules are NOT used
        return 0.05 + bump(h, 9.5, .8, 1.3) + bump(h, 18.5, .9, 1.3)
    if p == "residential":
        return 0.15 + bump(h, 8.25, 1.2, 1.2) + bump(h, 19.75, 1.6, 1.0)
    if p == "nightlife":
        return 0.1 + bump(h, 21.75, 1.6, 1.6 if not workday else 1.1) + bump(h, 13.5, 1.2, .3)
    if p == "events":
        return 0.1 + bump(h, 19, 2.0, .3)
    raise ValueError(p)


def season_factor(month):
    # assumption: slight dip in peak monsoon (Jul-Aug), festive uplift Oct-Nov, college holidays May
    return {1: 1.0, 2: 1.0, 3: 1.02, 4: 0.98, 5: 0.9, 6: 0.95, 7: 0.92, 8: 0.94, 9: 1.0, 10: 1.05, 11: 1.06, 12: 1.03}[month]


def rain_prob(month):  # assumption: Belagavi gets most rain June-September (south-west monsoon)
    return {6: .55, 7: .7, 8: .65, 9: .45, 10: .25, 11: .1}.get(month, .04)


def generate(seed=SEED):
    rng = np.random.default_rng(seed)
    days = [START + timedelta(days=d) for d in range(DAYS)]
    # synthetic scenario calendar (NOT the real calendar)
    holiday = np.zeros(DAYS, bool); holiday[rng.choice(DAYS, 14, replace=False)] = True
    festival_start = rng.choice(np.arange(5, DAYS - 10), 4, replace=False)
    festival = np.zeros(DAYS, bool)
    for s in festival_start: festival[s:s + int(rng.integers(2, 5))] = True
    event_day = rng.random(DAYS) < 0.06          # stadium event evenings
    flight_wave = rng.random(DAYS) < 0.30        # extra synthetic arrival wave at the airport
    station_surge = rng.random(DAYS) < 0.10      # synthetic late train / long-distance arrival cluster
    rain = np.zeros(DAYS, bool)
    for d, day in enumerate(days):               # Markov persistence: yesterday's rain raises today's odds
        p = rain_prob(day.month)
        rain[d] = rng.random() < (min(0.95, p + 0.25) if d and rain[d - 1] else p)
    day_effect = {z[0]: np.zeros(DAYS) for z in ZONES}
    for z in ZONES:
        e = 0.0
        for d in range(DAYS):
            e = 0.7 * e + rng.normal(0, 0.06); day_effect[z[0]][d] = e

    rows = []
    for zid, name, base, mix in ZONES:
        latent = 0.0
        shock = 0.0
        for d, day in enumerate(days):
            workday = day.weekday() < 5 and not holiday[d] and not festival[d]
            rain_window = (14 + rng.integers(0, 4), 20 + rng.integers(0, 3)) if rain[d] else None
            for b in range(BPD):
                h = b / 2
                prof = sum(w * purpose_curve(p, h, workday) for p, w in mix.items())
                is_rain = bool(rain_window and rain_window[0] <= h < rain_window[1])
                scheduled = 0
                add = 0.0
                if festival[d] and zid in (1, 2, 4) and 17 <= h < 23: add += 1.2; scheduled = 1
                if event_day[d] and zid == 7 and 21.5 <= h < 23: add += 4.0; scheduled = 1
                if flight_wave[d] and zid == 8 and 13 <= h < 14.5: add += 2.0; scheduled = 1
                if station_surge[d] and zid in (1, 2) and 23 <= h < 24: add += 1.5; scheduled = 1
                shock = 0.6 * shock + add                      # shocks decay over the next buckets (recovery)
                latent = 0.85 * latent + rng.normal(0, 0.12)   # correlated adjacent buckets
                lam = (base * prof * season_factor(day.month) * (1.3 if is_rain else 1.0) * (1.15 if festival[d] else 1.0)
                       * np.exp(day_effect[zid][d] + latent) + base * shock * 0.5)
                rows.append((zid, name, day + timedelta(minutes=30 * b), d, b, day.weekday(), int(day.weekday() >= 5),
                             int(holiday[d]), int(festival[d]), int(is_rain), scheduled, round(float(lam), 4), int(rng.poisson(lam))))
    df = pd.DataFrame(rows, columns=["zone_id", "zone_name", "ts", "day", "bucket", "dow", "weekend", "holiday", "festival",
                                     "rain", "scheduled_event", "expected_lambda", "demand"])
    df["synthetic"] = True; df["dataset_version"] = VERSION; df["seed"] = seed; df["city"] = "Belagavi (synthetic)"
    df["spatial_resolution"] = "8 demand zones (nearest zone centre)"; df["temporal_resolution"] = "30 min"
    df["scenario"] = np.where(df.festival == 1, "festival", np.where(df.scheduled_event == 1, "scheduled_event", np.where(df.rain == 1, "rain", "normal")))
    return df.sort_values(["zone_id", "ts"]).reset_index(drop=True)


def od_matrix():
    """Destination share by origin zone and time block (assumption: commute flows to office/industrial/college zones in
    the morning and back to residential zones in the evening; neighbours favoured). Rows sum to 1."""
    pull = {"morning": {3: 1.6, 5: 1.7, 6: 1.5, 1: 1.3}, "midday": {1: 1.7, 3: 1.3, 2: 1.1}, "evening": {4: 1.7, 2: 1.4, 7: 1.3, 1: 1.2},
            "night": {2: 1.5, 4: 1.3, 1: 1.1, 8: 0.5}}
    rows = []
    for block, p in pull.items():
        for o, *_ in ZONES:
            w = {}
            for dz, *_ in ZONES:
                w[dz] = 0.15 if dz == o else (1.0 if dz in NEIGHBOURS[o] else 0.35) * p.get(dz, 1.0) * (0.6 if dz == 8 else 1.0)
            s = sum(w.values())
            rows += [(block, o, dz, round(v / s, 4)) for dz, v in w.items()]
    return pd.DataFrame(rows, columns=["time_block", "origin_zone", "destination_zone", "share"])


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "data" / "v3"))
    a = ap.parse_args(); out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    df = generate(); od = od_matrix()
    df.to_csv(out / "demand_v3.csv", index=False); od.to_csv(out / "od_matrix_v3.csv", index=False)
    digest = hashlib.sha256(df[["zone_id", "ts", "demand"]].to_csv(index=False).encode()).hexdigest()
    meta = {"dataset_version": VERSION, "synthetic": True, "seed": SEED, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "city": "Belagavi (synthetic; zone names from OpenStreetMap, values simulated)", "rows": len(df), "zones": len(ZONES), "days": DAYS,
            "buckets_per_day": BPD, "period": [df.ts.min().isoformat(), df.ts.max().isoformat()], "content_sha256": digest,
            "mean_demand": round(float(df.demand.mean()), 3), "assumptions": "docs/DEMO_DATA_SPECIFICATION.md", "od_rows": len(od)}
    (out / "metadata_v3.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
