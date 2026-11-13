# Scenario Catalog (What-If Lab + Chaos Mode)

All values are SIMULATED. The default seed is 42 and is editable in the UI.

## What-If scenarios (Dispatch Arena)
| ID | Injection | How it reaches the forecast | Expected chain |
|---|---|---|---|
| `normal` | none | model forecast (base) | reference |
| `rush_hour` | demand ×1.6 in office zones (MG Road, Whitefield, Electronic City), 17:30–19:30 | **deterministic adjustment** (not a model feature; labelled) | gap ↑ in office zones → surge ↑ → reposition from residential |
| `heavy_rain` | `rain=1` in Koramangala, Indiranagar, HSR | **model feature** `rain` (real prediction from `forecast.json` variant) | forecast ↑ ≈30% → gap → surge → reposition |
| `concert_end` | `incident=1` in the Stadium zone at 22:00–23:00 | **model feature** `incident` | spike in one zone → strong surge (capped) → many moves |
| `airport_wave` | `incident=1` in Airport/Hebbal, 06:00–07:30 | **model feature** `incident` | airport gap; long deadhead |

The UI shows **before** (normal) beside **after** (scenario) for forecast, supply, gap, surge raw/smoothed and repositioning moves, then reruns both Arena worlds. **Apply** regenerates the input with the scenario. **Reset** returns to `normal` with the same seed.

## Chaos Mode (live rides, real RPCs)
| Button | RPC | Expected transitions | Event log |
|---|---|---|---|
| Reject | `chaos_inject(g,'reject')` | offered → requested → offered (attempt+1) | `offer_rejected`, `driver_excluded`, `offer_created` |
| Timeout | `chaos_inject(g,'no_response')` | same as reject, outcome `no_response` | `offer_no_response`, … |
| Driver cancel | `chaos_inject(g,'driver_cancel')` | accepted/arriving → requested → offered | `driver_cancelled`, … |
| Delay | `chaos_inject(g,'delay')` | arriving → requested → offered | `arrival_delayed`, … |

Each response returns `{exception_at, excluded_driver, next_driver, attempt_no, recovered_at|null, outcome}`. Recovery time = `next offer accepted_at − exception_at`, or `no_driver_found`. In fast-demo mode, seeded drivers auto-accept after 3 s (simulated) so recovery completes without a second laptop.

`demo_reset()` restores every seeded driver and clears demo rides.
