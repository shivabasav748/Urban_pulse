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

// [base, included_km, per_km, per_min]
const PRICE: Record<Category, [number, number, number, number]> = { bike: [20, 1.5, 6, 0.5], auto: [30, 1.5, 13, 1], cab: [55, 2, 17, 1.5] }

export type Fare = { base: number; distance: number; time: number; surge_mult: number; total: number; pool_discount?: number; included_km?: number; per_km?: number; per_min?: number }

export function fare(cat: Category, distKm: number, mins: number, surge = 1): Fare {
  const [base, incl, perKm, perMin] = PRICE[cat]
  const distance = Math.round(perKm * Math.max(distKm - incl, 0))
  const time = Math.round(perMin * mins)
  return { base, included_km: incl, per_km: perKm, per_min: perMin, distance, time, surge_mult: surge, total: Math.round((base + distance + time) * surge) }
}

export const inr = (n: number) => `₹${Math.round(n)}`
