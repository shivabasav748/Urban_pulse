// Mirrors public._rank() in SQL. Used by Dispatch Arena; live dispatch runs the SQL version.
export type Weights = { eta: number; workload: number; reliability: number; idle: number }
export const DEFAULT_WEIGHTS: Weights = { eta: 0.45, workload: 0.25, reliability: 0.2, idle: 0.1 }

/** zone_aware = the urban_pulse score scaled by (1 - ZONE_WEIGHT) + ZONE_WEIGHT x zone balance (settings.w_zone in SQL). */
export const ZONE_WEIGHT = 0.15

/** zoneSlack: expected supply minus 30-min demand in the candidate's current zone (higher = more spare captains there). */
export type Candidate = { id: string; pickupMin: number; tripsToday: number; offersAccepted: number; offersReceived: number; idleMin: number; reliability?: number; zoneSlack?: number }
export type Scored = Candidate & { c_eta: number; c_workload: number; c_reliability: number; c_idle: number; c_zone: number; score: number }
export type Policy = 'nearest' | 'urban_pulse' | 'zone_aware'

const r3 = (n: number) => Math.round(n * 1000) / 1000
const norm = (v: number, lo: number, hi: number) => (hi === lo ? null : (v - lo) / (hi - lo))

/** eta and workload: lower is better (inverted); reliability: Bayesian acceptance with prior 0.8; idle: longer wait is better. */
export function scoreDrivers(cands: Candidate[], policy: Policy = 'urban_pulse', w: Weights = DEFAULT_WEIGHTS, wZone = ZONE_WEIGHT): Scored[] {
  if (!cands.length) return []
  const span = (f: (c: Candidate) => number) => [Math.min(...cands.map(f)), Math.max(...cands.map(f))] as const
  const [pLo, pHi] = span((c) => c.pickupMin)
  const [tLo, tHi] = span((c) => c.tripsToday)
  const [iLo, iHi] = span((c) => c.idleMin)
  const [zLo, zHi] = span((c) => c.zoneSlack ?? 0)
  const wz = policy === 'zone_aware' ? wZone : 0
  const scored = cands.map((c) => {
    const c_eta = r3(1 - (norm(c.pickupMin, pLo, pHi) ?? 0))
    const c_workload = r3(1 - (norm(c.tripsToday, tLo, tHi) ?? 0))
    const c_reliability = r3(c.reliability ?? (c.offersAccepted + 4) / (c.offersReceived + 5))
    const c_idle = r3(norm(c.idleMin, iLo, iHi) ?? 1)
    const c_zone = r3(norm(c.zoneSlack ?? 0, zLo, zHi) ?? 1)
    const base = w.eta * c_eta + w.workload * c_workload + w.reliability * c_reliability + w.idle * c_idle
    const score = policy === 'nearest' ? -c.pickupMin : Math.round(((1 - wz) * base + wz * c_zone) * 1e4) / 1e4
    return { ...c, c_eta, c_workload, c_reliability, c_idle, c_zone, score }
  })
  return scored.sort((a, b) => b.score - a.score || a.pickupMin - b.pickupMin || a.id.localeCompare(b.id))
}
