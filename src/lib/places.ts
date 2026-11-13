// Seeded Bengaluru demo places (no geocoding API). Coordinates approximate, for the SIMULATED demo.
export type Place = { id: string; name: string; area: string; lat: number; lng: number }

export const PLACES: Place[] = [
  { id: 'forum', name: 'Forum Mall', area: 'Koramangala', lat: 12.9346, lng: 77.6113 },
  { id: 'kora5', name: '5th Block Jyoti Nivas', area: 'Koramangala', lat: 12.9352, lng: 77.6245 },
  { id: 'sony', name: 'Sony World Signal', area: 'Koramangala', lat: 12.9373, lng: 77.6268 },
  { id: 'indira100', name: '100 Feet Road', area: 'Indiranagar', lat: 12.9719, lng: 77.6412 },
  { id: 'indirametro', name: 'Indiranagar Metro', area: 'Indiranagar', lat: 12.9784, lng: 77.6408 },
  { id: 'mgmetro', name: 'MG Road Metro', area: 'MG Road', lat: 12.9755, lng: 77.6068 },
  { id: 'trinity', name: 'Trinity Circle', area: 'MG Road', lat: 12.9726, lng: 77.6197 },
  { id: 'cubbon', name: 'Cubbon Park', area: 'MG Road', lat: 12.9763, lng: 77.5929 },
  { id: 'hsr', name: 'HSR BDA Complex', area: 'HSR Layout', lat: 12.9116, lng: 77.6474 },
  { id: 'agara', name: 'Agara Lake', area: 'HSR Layout', lat: 12.9237, lng: 77.6431 },
  { id: 'itpl', name: 'ITPL Main Gate', area: 'Whitefield', lat: 12.9857, lng: 77.7359 },
  { id: 'phoenix', name: 'Phoenix Marketcity', area: 'Whitefield', lat: 12.9975, lng: 77.6966 },
  { id: 'infosys', name: 'Infosys Gate 1', area: 'Electronic City', lat: 12.8452, lng: 77.6602 },
  { id: 'stadium', name: 'Chinnaswamy Stadium', area: 'Stadium', lat: 12.9788, lng: 77.5996 },
  { id: 'hebbal', name: 'Hebbal Flyover', area: 'Hebbal', lat: 13.0358, lng: 77.597 },
  { id: 'jain', name: 'Jain University (JGI)', area: 'Jayanagar', lat: 12.9254, lng: 77.5838 },
]

export const BLR_CENTER: [number, number] = [12.955, 77.625]
