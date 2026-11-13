# Model card: Urban Pulse demand forecast (`hgb-v2-seed42`)

**Everything here is SIMULATED.** The model says nothing about real cities.

## Purpose
Predict ride demand per zone 30 minutes ahead, to drive the demo's forecast/arena views. Code: `ml/train.py`; self-check: `ml/test_train.py`.

## Data
Synthetic, `numpy` seed 42. 42 days from 2026-10-02, 8 Bengaluru zones, 30-minute buckets (48 per day, 16,128 rows in total). Demand is Poisson with rate = zone base x hand-designed hour-of-day curve x weekday factor x (1 + 0.3 rain) x incident boost. Rain days (25%), concert days (18%) and flight-wave days (35%) are drawn once per day.

Shocks:
- Stadium concert end (22:00-23:00, x4): **scheduled**, known in advance.
- Airport flight wave (06:00-07:30, x2): **scheduled**, known in advance.
- Random local incidents (1% of buckets in other zones, x1.6): **unpredictable**; they raise demand but are never visible to the model.

## Features
| Feature | Known at prediction time? |
|---|---|
| zone (categorical), hour, dow, weekend | Yes (calendar) |
| rain | Yes, treated as a weather forecast |
| scheduled_event (concert, flight wave) | Yes, scheduled |
| lag1 (latest bucket), roll4 (mean of last 4) | Yes, observed before the target |
| lag48 (yesterday), lag336 (last week) | Yes, observed |
| random incident | **No, excluded** |

## Target and horizon
Demand count in the next 30-minute bucket, predicted from data up to 30 minutes earlier.

## Model
`HistGradientBoostingRegressor(loss="poisson", max_iter=300, learning_rate=0.06, max_leaf_nodes=31, categorical_features=[zone], random_state=42)`.

## Split
Chronological: train days 8-35 (10,752 rows), test days 36-42 (2,304 rows). Days 1-7 only feed the lag features.

## Metrics (test set)
| | MAE |
|---|---|
| Model | 1.0149 |
| Seasonal-naive (same time last week, `lag336`) | 1.3077 |
| Improvement | 22.4% |

## Changes from v1
v1 used a single `incident` feature that included random local incidents, which cannot be known 30 minutes ahead. That leaked the future (v1 MAE 1.0204 vs baseline 1.3077). v2 splits the column: `incident` (all shocks) is used only to generate demand and for the `demand_observations` seed; the model sees `scheduled_event`. Demand values are unchanged (verified by hash). MAE moved only from 1.0204 to 1.0149, so the leak had little measurable effect here, but the inputs are now honest.

## Scenarios
- `base`: model on the test set.
- `heavy_rain`: `rain=1` for zones 1, 2, 4, 15:00-21:00, re-predicted.
- `concert_end`, `airport_wave`: `scheduled_event=1` for the Stadium / Hebbal window, re-predicted.
- `rush_hour`: not a model feature; a deterministic x1.6 on office zones 17:30-19:30, labelled in `model_version`.

## Limitations
Synthetic data generated from hand-picked curves; the model largely relearns those curves. One seed, one split, no uncertainty intervals. Scenario effects are only as good as the generator's assumptions. Not validated on any real city.
