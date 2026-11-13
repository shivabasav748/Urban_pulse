// Mirrors public._km / _minutes / _fare in supabase/migrations/*_rpc.sql. SIMULATED routing.
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
  return (peak ? 18 : 26) * (cat === 'bike' ? 1.15 : 1)
}

export function minutes(distKm: number, cat: Category, hour: number): number {
  return Math.round((distKm / speedKmh(cat, hour)) * 600) / 10
}

const PRICE: Record<Category, [number, number, number]> = { bike: [20, 6, 1], auto: [30, 11, 1.5], cab: [50, 15, 2] }

export type Fare = { base: number; distance: number; time: number; surge_mult: number; total: number; pool_discount?: number }

export function fare(cat: Category, distKm: number, mins: number, surge = 1): Fare {
  const [base, perKm, perMin] = PRICE[cat]
  const distance = Math.round(perKm * distKm)
  const time = Math.round(perMin * mins)
  return { base, distance, time, surge_mult: surge, total: Math.round((base + distance + time) * surge) }
}

export const inr = (n: number) => `₹${Math.round(n)}`
