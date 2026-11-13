// Belagavi (Belgaum) demo landmarks. Coordinates from a one-time OpenStreetMap Nominatim lookup (13 Nov 2026),
// stored here so the app never calls a geocoder (public Nominatim forbids autocomplete). Demo use only.
export type Place = { id: string; name: string; area: string; lat: number; lng: number }

export const PLACES: Place[] = [
  { id: 'rani-channamma-circle', name: "Rani Channamma Circle", area: "Khade Bazar", lat: 15.86723, lng: 74.51172 },
  { id: 'central-bus-stand', name: "Central Bus Stand (CBT)", area: "Belgaum Fort", lat: 15.86388, lng: 74.52106 },
  { id: 'khade-bazar', name: "Khade Bazar", area: "Khade Bazar", lat: 15.86112, lng: 74.51492 },
  { id: 'sardar-maidan', name: "Sardar Ground (Sardar Maidan)", area: "Khade Bazar", lat: 15.86608, lng: 74.51009 },
  { id: 'nucleus-mall', name: "Nucleus Mall", area: "Khade Bazar", lat: 15.85871, lng: 74.50831 },
  { id: 'gogte-circle', name: "Gogte Circle", area: "Tilakwadi", lat: 15.84797, lng: 74.50694 },
  { id: 'belagavi-fort', name: "Belagavi Fort (Kote)", area: "Belgaum Fort", lat: 15.85839, lng: 74.52416 },
  { id: 'kote-kere', name: "Kote Kere", area: "Belgaum Fort", lat: 15.86647, lng: 74.52638 },
  { id: 'camp', name: "Camp", area: "Camp", lat: 15.8515, lng: 74.49966 },
  { id: 'inox-chandan', name: "INOX (Chandan) Cinema", area: "Shastri Nagar", lat: 15.85293, lng: 74.50936 },
  { id: 'railway-station', name: "Belagavi Railway Station", area: "Shastri Nagar", lat: 15.84906, lng: 74.50894 },
  { id: 'tilakwadi', name: "Tilakwadi", area: "Tilakwadi", lat: 15.83686, lng: 74.50193 },
  { id: 'rpd-ground', name: "RPD Ground", area: "Adarsh Nagar", lat: 15.83368, lng: 74.50645 },
  { id: 'arun-theatre', name: "Arun Theatre", area: "Tilakwadi", lat: 15.84219, lng: 74.50299 },
  { id: 'shahapur', name: "Shahapur", area: "Shahapur", lat: 15.84007, lng: 74.51777 },
  { id: 'vadgaon', name: "Vadgaon", area: "Vadgaon", lat: 15.83359, lng: 74.52421 },
  { id: 'angol', name: "Angol", area: "Angol", lat: 15.823, lng: 74.5031 },
  { id: 'bhagya-nagar', name: "Bhagya Nagar", area: "Bhagya Nagar", lat: 15.83068, lng: 74.50668 },
  { id: 'rani-chennamma-nagar', name: "Rani Chennamma Nagar", area: "Udyambag side", lat: 15.8271, lng: 74.4907 },
  { id: 'jnmc-kles-nehru-nagar', name: "KLE Hospital / JNMC, Nehru Nagar", area: "Nehru Nagar", lat: 15.8879, lng: 74.51992 },
  { id: 'sadashiv-nagar', name: "Sadashiv Nagar", area: "Sadashiv Nagar", lat: 15.8783, lng: 74.50848 },
  { id: 'mahantesh-nagar', name: "Mahantesh Nagar", area: "Mahantesh Nagar", lat: 15.87714, lng: 74.53318 },
  { id: 'ramteerth-nagar', name: "Ramteerth Nagar", area: "Ramteerth Nagar", lat: 15.88523, lng: 74.54242 },
  { id: 'ksca-stadium', name: "KSCA Stadium", area: "Ramteerth Nagar", lat: 15.88564, lng: 74.54633 },
  { id: 'gandhi-nagar', name: "Gandhi Nagar", area: "Gandhi Nagar", lat: 15.86238, lng: 74.53185 },
  { id: 'udyambag', name: "Udyambag", area: "Udyambag", lat: 15.81746, lng: 74.49263 },
  { id: 'machhe', name: "Machhe", area: "Machhe", lat: 15.79159, lng: 74.48406 },
  // JCER is not in OpenStreetMap; approximate position near Hunchyanatti Cross, Machhe (address from the college listing).
  { id: 'jcer', name: "JCER (Jain College of Engineering and Research)", area: "Machhe · approximate", lat: 15.7975, lng: 74.4810 },
  { id: 'vtu', name: "Visvesvaraya Technological University", area: "Jnana Sangama", lat: 15.7773, lng: 74.46486 },
  { id: 'piranwadi', name: "Piranwadi", area: "Piranwadi", lat: 15.80046, lng: 74.4791 },
  { id: 'hindalga', name: "Hindalga", area: "Hindalga", lat: 15.87343, lng: 74.47427 },
  { id: 'kanbargi-pond', name: "Kanbargi Pond", area: "Kanbargi", lat: 15.89132, lng: 74.55407 },
  { id: 'auto-nagar', name: "Auto Nagar", area: "Auto Nagar", lat: 15.89419, lng: 74.54309 },
  { id: 'airport', name: "Belagavi Airport (Sambra)", area: "Sambra", lat: 15.86308, lng: 74.61119 },
  { id: 'suvarna-soudha', name: "Suvarna Vidhana Soudha", area: "Halaga", lat: 15.81365, lng: 74.57038 },
  { id: 'kakati', name: "Kakati", area: "Kakati", lat: 15.93267, lng: 74.52555 },
]

/** Demo stand-in when a browser location fix is too coarse to use (desktop Wi-Fi fixes are often 1 km+ off). */
export const DEMO_HOME_ID = 'jcer'

export const CITY_CENTER: [number, number] = [15.855, 74.52]
export const CITY_NAME = 'Belagavi'

/** Demo service area, same box the server enforces in update_location. */
export const inDemoArea = (lat: number, lng: number) => lat >= 15.7 && lat <= 16.0 && lng >= 74.4 && lng <= 74.7

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
