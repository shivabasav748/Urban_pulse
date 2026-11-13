// Feature C. Two-rider pooling: brute-force the 6 valid stop orders (each pickup before its drop),
// keep orders where every rider's detour <= maxDetourPct, choose minimum total time.
// Limits: 2 riders, straight-line legs x road factor, no traffic.
import { fare, km, minutes, type Fare, type LatLng } from './geo'

export type PoolRide = { id: string; pickup: LatLng & { label: string }; drop: LatLng & { label: string } }
export type Stop = { ride_id: string; type: 'pickup' | 'drop'; label: string; lat: number; lng: number }
export type PoolPlan = {
  compatible: boolean; reason?: string
  stops?: Stop[]; pooledMin?: number; separateMin?: number
  perRider?: { id: string; soloMin: number; pooledMin: number; addedMin: number; detourPct: number; soloFare: Fare; pooledFare: number; savedPct: number }[]
}

export const POOL = { maxPickupKm: 1.5, maxDropKm: 2.5, maxDetourPct: 40, discount: 0.25 }

export function planPool(a: PoolRide, b: PoolRide, hour: number, opts = POOL): PoolPlan {
  const pk = km(a.pickup, b.pickup) / 1.35, dk = km(a.drop, b.drop) / 1.35 // compare straight-line gaps
  if (pk > opts.maxPickupKm) return { compatible: false, reason: `pickups ${pk.toFixed(1)} km apart (max ${opts.maxPickupKm})` }
  if (dk > opts.maxDropKm) return { compatible: false, reason: `drops ${dk.toFixed(1)} km apart (max ${opts.maxDropKm})` }

  const S = (r: PoolRide, type: 'pickup' | 'drop'): Stop => ({ ride_id: r.id, type, label: r[type].label, lat: r[type].lat, lng: r[type].lng })
  const [Pa, Da, Pb, Db] = [S(a, 'pickup'), S(a, 'drop'), S(b, 'pickup'), S(b, 'drop')]
  const orders = [[Pa, Pb, Da, Db], [Pa, Pb, Db, Da], [Pb, Pa, Da, Db], [Pb, Pa, Db, Da], [Pa, Da, Pb, Db], [Pb, Db, Pa, Da]]
  const leg = (x: Stop, y: Stop) => minutes(km(x, y), 'cab', hour)
  const solo = (r: PoolRide) => minutes(km(r.pickup, r.drop), 'cab', hour)

  let best: PoolPlan | null = null
  for (const order of orders) {
    const t: number[] = [0]
    for (let i = 1; i < order.length; i++) t.push(t[i - 1] + leg(order[i - 1], order[i]))
    const ride = (r: PoolRide) => {
      const i = order.findIndex((s) => s.ride_id === r.id && s.type === 'pickup')
      const j = order.findIndex((s) => s.ride_id === r.id && s.type === 'drop')
      return t[j] - t[i]
    }
    const per = [a, b].map((r) => {
      const soloMin = solo(r), pooledMin = Math.round(ride(r) * 10) / 10
      const sf = fare('cab', km(r.pickup, r.drop), soloMin)
      const pooledFare = Math.round(sf.total * (1 - opts.discount))
      return { id: r.id, soloMin, pooledMin, addedMin: Math.round((pooledMin - soloMin) * 10) / 10,
        detourPct: Math.round(((pooledMin - soloMin) / soloMin) * 100), soloFare: sf, pooledFare,
        savedPct: Math.round((1 - pooledFare / sf.total) * 100) }
    })
    if (per.some((p) => p.detourPct > opts.maxDetourPct)) continue
    const total = Math.round(t[t.length - 1] * 10) / 10
    if (!best || total < best.pooledMin!) {
      best = { compatible: true, stops: order, pooledMin: total, separateMin: Math.round((solo(a) + solo(b)) * 10) / 10, perRider: per }
    }
  }
  return best ?? { compatible: false, reason: `every stop order exceeds ${opts.maxDetourPct}% detour` }
}
