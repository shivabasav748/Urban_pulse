// Curated Bengaluru demo landmarks (no geocoding API: public Nominatim forbids autocomplete).
// Coordinates are approximate and SIMULATED-demo only; never presented as surveyed addresses.
export type Place = { id: string; name: string; area: string; lat: number; lng: number }

export const PLACES: Place[] = [
  { id: 'forum', name: 'Forum Mall', area: 'Koramangala', lat: 12.9346, lng: 77.6113 },
  { id: 'kora5', name: '5th Block Jyoti Nivas', area: 'Koramangala', lat: 12.9352, lng: 77.6245 },
  { id: 'sony', name: 'Sony World Signal', area: 'Koramangala', lat: 12.9373, lng: 77.6268 },
  { id: 'indira100', name: '100 Feet Road', area: 'Indiranagar', lat: 12.9719, lng: 77.6412 },
  { id: 'indirametro', name: 'Indiranagar Metro', area: 'Indiranagar', lat: 12.9784, lng: 77.6408 },
  { id: 'domlur', name: 'Domlur Flyover', area: 'Domlur', lat: 12.961, lng: 77.6387 },
  { id: 'mgmetro', name: 'MG Road Metro', area: 'MG Road', lat: 12.9755, lng: 77.6068 },
  { id: 'trinity', name: 'Trinity Circle', area: 'MG Road', lat: 12.9726, lng: 77.6197 },
  { id: 'brigade', name: 'Brigade Road', area: 'MG Road', lat: 12.9719, lng: 77.607 },
  { id: 'commercial', name: 'Commercial Street', area: 'Shivajinagar', lat: 12.9822, lng: 77.609 },
  { id: 'ulsoor', name: 'Ulsoor Lake', area: 'Halasuru', lat: 12.983, lng: 77.619 },
  { id: 'ubcity', name: 'UB City', area: 'Ashok Nagar', lat: 12.9716, lng: 77.596 },
  { id: 'cubbon', name: 'Cubbon Park', area: 'MG Road', lat: 12.9763, lng: 77.5929 },
  { id: 'stadium', name: 'Chinnaswamy Stadium', area: 'Stadium', lat: 12.9788, lng: 77.5996 },
  { id: 'majestic', name: 'Kempegowda Bus Station', area: 'Majestic', lat: 12.9767, lng: 77.5713 },
  { id: 'citystation', name: 'Bengaluru City Railway Station', area: 'Majestic', lat: 12.978, lng: 77.5695 },
  { id: 'mantri', name: 'Mantri Square Mall', area: 'Malleshwaram', lat: 12.9916, lng: 77.5712 },
  { id: 'malleshwaram', name: '8th Cross Market', area: 'Malleshwaram', lat: 13.0035, lng: 77.57 },
  { id: 'rajajinagar', name: 'Rajajinagar Metro', area: 'Rajajinagar', lat: 12.991, lng: 77.555 },
  { id: 'yeshwanthpur', name: 'Yeshwanthpur Junction', area: 'Yeshwanthpur', lat: 13.0285, lng: 77.5409 },
  { id: 'hebbal', name: 'Hebbal Flyover', area: 'Hebbal', lat: 13.0358, lng: 77.597 },
  { id: 'manyata', name: 'Manyata Tech Park', area: 'Nagawara', lat: 13.0451, lng: 77.6266 },
  { id: 'lalbagh', name: 'Lalbagh West Gate', area: 'Basavanagudi', lat: 12.9507, lng: 77.5848 },
  { id: 'jain', name: 'Jain University (JGI)', area: 'Jayanagar', lat: 12.9254, lng: 77.5838 },
  { id: 'jayanagar4', name: 'Jayanagar 4th Block', area: 'Jayanagar', lat: 12.9299, lng: 77.5823 },
  { id: 'banashankari', name: 'Banashankari Temple', area: 'Banashankari', lat: 12.9255, lng: 77.5468 },
  { id: 'jpnagar', name: 'JP Nagar 6th Phase', area: 'JP Nagar', lat: 12.9063, lng: 77.5857 },
  { id: 'btm', name: 'BTM Layout Water Tank', area: 'BTM Layout', lat: 12.9166, lng: 77.6101 },
  { id: 'silkboard', name: 'Silk Board Junction', area: 'BTM Layout', lat: 12.9177, lng: 77.6238 },
  { id: 'hsr', name: 'HSR BDA Complex', area: 'HSR Layout', lat: 12.9116, lng: 77.6474 },
  { id: 'agara', name: 'Agara Lake', area: 'HSR Layout', lat: 12.9237, lng: 77.6431 },
  { id: 'ecospace', name: 'RMZ Ecospace', area: 'Bellandur', lat: 12.9265, lng: 77.68 },
  { id: 'marathahalli', name: 'Marathahalli Bridge', area: 'Marathahalli', lat: 12.9569, lng: 77.7011 },
  { id: 'bagmane', name: 'Bagmane Tech Park', area: 'CV Raman Nagar', lat: 12.98, lng: 77.662 },
  { id: 'phoenix', name: 'Phoenix Marketcity', area: 'Whitefield', lat: 12.9975, lng: 77.6966 },
  { id: 'itpl', name: 'ITPL Main Gate', area: 'Whitefield', lat: 12.9857, lng: 77.7359 },
  { id: 'meenakshi', name: 'Meenakshi Mall', area: 'Bannerghatta Road', lat: 12.876, lng: 77.596 },
  { id: 'infosys', name: 'Infosys Gate 1', area: 'Electronic City', lat: 12.8452, lng: 77.6602 },
]

export const BLR_CENTER: [number, number] = [12.955, 77.625]

/** Demo service area, same box the server enforces in update_location. */
export const inDemoArea = (lat: number, lng: number) => lat >= 12.7 && lat <= 13.2 && lng >= 77.4 && lng <= 77.9

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r
  return Math.sqrt(x * x + y * y) * 6371000
}

/** Closest landmark and how far away it is (straight line). */
export function nearestPlace(lat: number, lng: number) {
  let best = PLACES[0], d = Infinity
  for (const p of PLACES) { const m = metres({ lat, lng }, p); if (m < d) { d = m; best = p } }
  return { place: best, metres: Math.round(d) }
}

/** A point the user chose by GPS or by tapping the map, named after the nearest landmark. */
export function pointPlace(lat: number, lng: number, kind: 'gps' | 'pin'): Place {
  const { place, metres: m } = nearestPlace(lat, lng)
  const near = m < 150 ? `at ${place.name}` : `${m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`} from ${place.name}`
  return { id: `${kind}:${lat.toFixed(5)},${lng.toFixed(5)}`, name: kind === 'gps' ? 'Current location' : 'Pinned location', area: near, lat, lng }
}

export const searchPlaces = (q: string) => {
  const s = q.trim().toLowerCase()
  return s ? PLACES.filter((p) => `${p.name} ${p.area}`.toLowerCase().includes(s)) : PLACES
}
