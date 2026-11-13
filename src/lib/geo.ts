// Mirrors public._km / _minutes / _fare / _speed_kmh (latest: migration 20261113000006_belagavi.sql). SIMULATED routing
// and made-up demo prices for Belagavi; see docs/FARES.md.
export type Category = 'bike' | 'auto' | 'cab'
export type LatLng = { lat: number; lng: number }

export const ROAD_FACTOR = 1.35

export function km(a: LatLng, b: LatLng): number {
  const R = 6371.0088
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h)) * ROAD_FACTOR
}

export function speedKmh(cat: Category, hour: number): number {
  const peak = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20)
  return (peak ? 20 : 28) * (cat === 'bike' ? 1.15 : 1)
}

export function minutes(distKm: number, cat: Category, hour: number): number {
  return Math.round((distKm / speedKmh(cat, hour)) * 600) / 10
}

/** Fare model v2 (migration 0009, mirrored in public._fare). See docs/FARE_ECONOMICS_AND_MARKET_BENCHMARK.md.
 *  cab : Karnataka aggregator city-taxi band 1 (vehicle cost up to Rs 10 lakh): Rs 100 for the first 4 km, Rs 24/km after,
 *        +10% between 00:00 and 06:00, 5% GST. Source: Karnataka order of Feb 2024 as reported (primary notification not
 *        retrieved). No per-minute journey charge (the tariff has none).
 *  auto: ILLUSTRATIVE (Belagavi auto tariff not verified): Rs 30 for the first 1.5 km, Rs 15/km after.
 *  bike: ILLUSTRATIVE, SIMULATED SERVICE (no bike-taxi permits verified in Karnataka): Rs 20 for 1.5 km, Rs 6/km after.
 *  Surge: off unless the operator enables it (settings.surge_enabled); then capped at 2x (MoRTH guideline 2025). */
export const TARIFF: Record<Category, { base: number; incl: number; perKm: number; nightPct: number; gstPct: number; source: string }> = {
  bike: { base: 20, incl: 1.5, perKm: 6, nightPct: 0, gstPct: 0, source: 'illustrative-simulated-service' },
  auto: { base: 30, incl: 1.5, perKm: 15, nightPct: 0, gstPct: 0, source: 'illustrative-not-notified' },
  cab: { base: 100, incl: 4, perKm: 24, nightPct: 10, gstPct: 5, source: 'karnataka-aggregator-cab-band1-2024' },
}
export const SURGE_CAP = 2

export type Fare = { base: number; distance: number; time: number; surge_mult: number; total: number; pool_discount?: number; included_km?: number
  per_km?: number; per_min?: number; night?: number; gst?: number; tariff?: string }

/** mins is accepted for call compatibility and ignored: no per-minute journey charge. night: booking between 00:00 and 06:00. */
export function fare(cat: Category, distKm: number, _mins = 0, surge = 1, night = false): Fare {
  const t = TARIFF[cat]
  const distance = Math.round(t.perKm * Math.max(distKm - t.incl, 0))
  const nightAmt = night ? Math.round((t.base + distance) * t.nightPct / 100) : 0
  const s = Math.min(Math.max(surge, 1), SURGE_CAP)
  const preTax = Math.round((t.base + distance + nightAmt) * s)
  const gst = Math.round(preTax * t.gstPct / 100)
  return { base: t.base, included_km: t.incl, per_km: t.perKm, per_min: 0, distance, time: 0, night: nightAmt, surge_mult: s, gst, total: preTax + gst, tariff: t.source }
}

export const inr = (n: number) => `₹${Math.round(n)}`
