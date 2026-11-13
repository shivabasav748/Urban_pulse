// Dispatch Arena: deterministic A/B simulator. Pure functions, no I/O, no Math.random. All values SIMULATED.
// See docs/DISPATCH_ARENA.md for the metric dictionary.
import { scoreDrivers, type Policy } from '@/lib/allocation'
import { km, minutes, type LatLng } from '@/lib/geo'
import { surgeRaw } from '@/lib/surge'
import forecastJson from './forecast.json'

export const ALGORITHM_VERSION = 'arena-v1 (score weights .45/.25/.20/.10, greedy repositioning every 15 min)'

export type ScenarioId = 'base' | 'rush_hour' | 'heavy_rain' | 'concert_end' | 'airport_wave'
export const ARENA_SCENARIOS: Record<ScenarioId, { label: string; startHour: number; how: string }> = {
  base: { label: 'Normal evening', startHour: 17, how: 'model forecast' },
  rush_hour: { label: 'Rush hour (office zones ×1.6)', startHour: 17.5, how: 'deterministic adjustment, not a model feature' },
  heavy_rain: { label: 'Heavy rain (Koramangala, Indiranagar, HSR)', startHour: 17, how: 'model feature: rain' },
  concert_end: { label: 'Concert ends at Stadium', startHour: 21.5, how: 'model feature: incident' },
  airport_wave: { label: 'Airport flight wave (Hebbal)', startHour: 5.5, how: 'model feature: incident' },
}

const ZONES = [
  { id: 1, lat: 12.9352, lng: 77.6245 }, { id: 2, lat: 12.9719, lng: 77.6412 }, { id: 3, lat: 12.9733, lng: 77.617 },
  { id: 4, lat: 12.9116, lng: 77.6474 }, { id: 5, lat: 12.9698, lng: 77.75 }, { id: 6, lat: 12.8452, lng: 77.6602 },
  { id: 7, lat: 12.9788, lng: 77.5996 }, { id: 8, lat: 13.0358, lng: 77.597 },
]
const FC = forecastJson.scenarios as Record<string, Record<string, number[]>>

// ---------- deterministic RNG ----------
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const poisson = (rng: () => number, lam: number) => { let k = 0, p = 1; const L = Math.exp(-lam); do { k++; p *= rng() } while (p > L); return k - 1 }
const jitter = (rng: () => number, p: LatLng, kmR: number): LatLng => {
  const r = kmR * Math.sqrt(rng()), th = 2 * Math.PI * rng()
  return { lat: p.lat + (r / 111) * Math.cos(th), lng: p.lng + (r / (111 * Math.cos((p.lat * Math.PI) / 180))) * Math.sin(th) }
}
const nearestZone = (p: LatLng) => ZONES.reduce((b, z) => (km(p, z) < km(p, b) ? z : b)).id

// ---------- input ----------
export type SimDriver = LatLng & { id: string; tripsToday: number; offersReceived: number; offersAccepted: number; idleMin: number; acceptProb: number }
export type SimRequest = { id: string; t: number; pickup: LatLng; drop: LatLng; zone: number; rolls: number[]; etaNoise: number }
export type ScenarioInput = { runId: string; seed: number; scenario: ScenarioId; startHour: number; horizonMin: number; tickMin: number; fleet: SimDriver[]; requests: SimRequest[]; algorithmVersion: string }

export function generateInput(seed: number, scenario: ScenarioId, fleetSize = 28, horizonMin = 120): ScenarioInput {
  const rng = mulberry32(seed)
  const { startHour } = ARENA_SCENARIOS[scenario]
  const fleet: SimDriver[] = Array.from({ length: fleetSize }, (_, i) => {
    const z = ZONES[i % ZONES.length]
    const received = 10, acceptProb = 0.55 + 0.4 * rng()
    return { id: `D${String(i + 1).padStart(2, '0')}`, ...jitter(rng, z, 1.2), tripsToday: Math.floor(rng() * 8),
      offersReceived: received, offersAccepted: Math.round(acceptProb * received), idleMin: Math.round(rng() * 30), acceptProb }
  })
  const requests: SimRequest[] = []
  for (let b = 0; b < horizonMin / 30; b++) {
    const bucket = Math.floor(startHour * 2) + b
    for (const z of ZONES) {
      const lam = FC[scenario][String(z.id)][bucket % 48] ?? 0
      const n = poisson(rng, lam)
      for (let k = 0; k < n; k++) {
        const pickup = jitter(rng, z, 1.2)
        let drop = jitter(rng, pickup, 7)
        if (km(pickup, drop) < 2) drop = jitter(rng, pickup, 7)
        requests.push({ id: '', t: Math.round((b * 30 + rng() * 30) * 2) / 2, pickup, drop, zone: z.id,
          rolls: Array.from({ length: 8 }, rng), etaNoise: 0.85 + 0.4 * rng() })
      }
    }
  }
  requests.sort((a, b) => a.t - b.t || a.zone - b.zone)
  requests.forEach((r, i) => (r.id = `R${String(i + 1).padStart(3, '0')}`))
  return { runId: `run-${seed}-${scenario}`, seed, scenario, startHour, horizonMin, tickMin: 0.5, fleet, requests, algorithmVersion: ALGORITHM_VERSION }
}

// ---------- world ----------
type DState = SimDriver & { freeAt: number; busyMin: number; deadheadKm: number; repoKm: number; assigned: number; holding: boolean }
type RState = { req: SimRequest; excluded: Set<string>; offer?: { driver: string; decideAt: number; outcome: 'accept' | 'reject' | 'no_response'; etaMin: number; dhKm: number }
  attempts: number; acceptedAt?: number; pickupAt?: number; completeAt?: number; predictedEta?: number; actualEta?: number; status: 'waiting' | 'offered' | 'assigned' | 'unserved' }

export type WorldResult = {
  policy: Policy; reposition: boolean
  metrics: Record<MetricKey, number | null>
  counts: { submitted: number; completed: number; inFlight: number; unserved: number; reassignments: number }
  perDriver: { id: string; assigned: number; busyMin: number }[]
  timeline: { t: number; served: number; waiting: number }[]
}
export type MetricKey = 'matchWaitAvg' | 'matchWaitMedian' | 'pickupWaitAvg' | 'etaErrAvg' | 'utilization' | 'completionRate' | 'deadheadKm' | 'repoKm' | 'tripRange' | 'gini'

const RESPONSE_MIN = 0.5, TIMEOUT_MIN = 1.5, ABANDON_MIN = 10, RADIUS_KM = 8

export function runWorld(input: ScenarioInput, policy: Policy, reposition: boolean): WorldResult {
  const hour = (t: number) => (input.startHour + t / 60) % 24
  const drivers: DState[] = input.fleet.map((d) => ({ ...d, freeAt: 0, busyMin: 0, deadheadKm: 0, repoKm: 0, assigned: 0, holding: false }))
  const reqs: RState[] = input.requests.map((req) => ({ req, excluded: new Set(), attempts: 0, status: 'waiting' }))
  let reassignments = 0
  const timeline: WorldResult['timeline'] = []

  for (let t = 0; t <= input.horizonMin; t += input.tickMin) {
    const free = () => drivers.filter((d) => d.freeAt <= t && !d.holding)
    // resolve offers due now
    for (const r of reqs) {
      if (r.status !== 'offered' || !r.offer || r.offer.decideAt > t) continue
      const d = drivers.find((x) => x.id === r.offer!.driver)!
      d.holding = false
      if (r.offer.outcome === 'accept') {
        const actualEta = r.offer.etaMin * r.req.etaNoise
        const trip = minutes(km(r.req.pickup, r.req.drop), 'cab', hour(t))
        Object.assign(r, { status: 'assigned', acceptedAt: t, predictedEta: r.offer.etaMin, actualEta, pickupAt: t + actualEta, completeAt: t + actualEta + trip })
        d.offersAccepted++; d.assigned++; d.tripsToday++
        d.busyMin += Math.min(actualEta + trip, input.horizonMin - t); d.deadheadKm += r.offer.dhKm
        d.freeAt = t + actualEta + trip; d.lat = r.req.drop.lat; d.lng = r.req.drop.lng; d.idleMin = 0
      } else {
        r.excluded.add(d.id); r.status = 'waiting'; r.offer = undefined; reassignments++
      }
    }
    // proactive repositioning (Urban Pulse side only), every 15 sim-minutes
    if (reposition && t % 15 === 0) {
      const bucket = Math.floor(input.startHour * 2 + (t + 30) / 30) % 48
      const idle = free()
      const supply = new Map<number, DState[]>(ZONES.map((z) => [z.id, idle.filter((d) => nearestZone(d) === z.id)]))
      const fc = (z: number) => FC[input.scenario][String(z)][bucket] ?? 0
      const deficit = ZONES.map((z) => ({ z, gap: fc(z.id) - supply.get(z.id)!.length })).filter((x) => x.gap >= 1).sort((a, b) => b.gap - a.gap || a.z.id - b.z.id)
      for (const { z, gap } of deficit) {
        for (let k = 0; k < Math.floor(gap); k++) {
          const donors = ZONES.filter((s) => supply.get(s.id)!.length - Math.ceil(fc(s.id)) > 0).flatMap((s) => supply.get(s.id)!)
          const pick = donors.sort((a, b) => km(a, z) - km(b, z) || a.id.localeCompare(b.id))[0]
          if (!pick) break
          const from = nearestZone(pick)
          supply.set(from, supply.get(from)!.filter((d) => d !== pick)); supply.get(z.id)!.push(pick)
          const dist = km(pick, z), mins = minutes(dist, 'cab', hour(t))
          pick.repoKm += dist; pick.freeAt = t + mins; pick.lat = z.lat; pick.lng = z.lng
        }
      }
    }
    // abandon + match waiting requests FIFO
    for (const r of reqs) {
      if (r.status !== 'waiting' || r.req.t > t) continue
      if (t - r.req.t > ABANDON_MIN) { r.status = 'unserved'; continue }
      const cands = free().filter((d) => !r.excluded.has(d.id)).map((d) => ({ d, k: km(d, r.req.pickup) })).filter((x) => x.k <= RADIUS_KM)
      if (!cands.length) continue
      const ranked = scoreDrivers(cands.map(({ d, k }) => ({ id: d.id, pickupMin: minutes(k, 'cab', hour(t)), tripsToday: d.tripsToday,
        idleMin: d.idleMin + Math.max(0, t - d.freeAt), offersAccepted: d.offersAccepted, offersReceived: d.offersReceived })), policy)
      const best = ranked[0], d = drivers.find((x) => x.id === best.id)!
      const roll = r.req.rolls[Math.min(r.attempts, r.req.rolls.length - 1)]
      const outcome = roll < d.acceptProb ? 'accept' : roll < d.acceptProb + (1 - d.acceptProb) / 2 ? 'reject' : 'no_response'
      r.attempts++; d.offersReceived++; d.holding = true; r.status = 'offered'
      r.offer = { driver: d.id, decideAt: t + (outcome === 'no_response' ? TIMEOUT_MIN : RESPONSE_MIN), outcome, etaMin: best.pickupMin, dhKm: cands.find((c) => c.d === d)!.k }
    }
    if (t % 5 === 0) timeline.push({ t, served: reqs.filter((r) => r.status === 'assigned').length, waiting: reqs.filter((r) => (r.status === 'waiting' || r.status === 'offered') && r.req.t <= t).length })
  }

  const acc = reqs.filter((r) => r.acceptedAt != null)
  const picked = acc.filter((r) => r.pickupAt! <= input.horizonMin)
  const completed = acc.filter((r) => r.completeAt! <= input.horizonMin).length
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)
  const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
  const counts = drivers.map((d) => d.assigned)
  const mean = avg(counts) ?? 0
  const gini = mean ? counts.reduce((s, x) => s + counts.reduce((s2, y) => s2 + Math.abs(x - y), 0), 0) / (2 * counts.length ** 2 * mean) : null
  const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100)

  return {
    policy, reposition, timeline,
    metrics: {
      matchWaitAvg: r2(avg(acc.map((r) => r.acceptedAt! - r.req.t))),
      matchWaitMedian: r2(median(acc.map((r) => r.acceptedAt! - r.req.t))),
      pickupWaitAvg: r2(avg(picked.map((r) => r.pickupAt! - r.req.t))),
      etaErrAvg: r2(avg(picked.map((r) => Math.abs(r.actualEta! - r.predictedEta!)))),
      utilization: r2(drivers.reduce((s, d) => s + d.busyMin, 0) / (drivers.length * input.horizonMin)),
      completionRate: reqs.length ? r2(completed / reqs.length) : null,
      deadheadKm: r2(drivers.reduce((s, d) => s + d.deadheadKm, 0)),
      repoKm: r2(drivers.reduce((s, d) => s + d.repoKm, 0)),
      tripRange: Math.max(...counts) - Math.min(...counts),
      gini: r2(gini),
    },
    counts: { submitted: reqs.length, completed, inFlight: acc.length - completed, unserved: reqs.filter((r) => r.status === 'unserved').length, reassignments },
    perDriver: drivers.map((d) => ({ id: d.id, assigned: d.assigned, busyMin: Math.round(d.busyMin) })),
  }
}

export type ArenaRun = { input: ScenarioInput; baseline: WorldResult; urbanPulse: WorldResult; ranAt: string }
export function runArena(seed: number, scenario: ScenarioId, reposition = true): ArenaRun {
  const input = generateInput(seed, scenario)
  return {
    input,
    baseline: runWorld(structuredClone(input), 'nearest', false),
    urbanPulse: runWorld(structuredClone(input), 'urban_pulse', reposition),
    ranAt: new Date().toISOString(),
  }
}

/** What-If chain at the scenario start: forecast -> supply gap -> surge (shared formula). */
export function scenarioChain(input: ScenarioInput) {
  const bucket = Math.floor(input.startHour * 2) % 48
  return ZONES.map((z) => {
    const forecast = FC[input.scenario][String(z.id)][bucket], base = FC.base[String(z.id)][bucket]
    const supply = input.fleet.filter((d) => nearestZone(d) === z.id).length
    return { zone: z.id, base: Math.round(base * 100) / 100, forecast: Math.round(forecast * 100) / 100, supply,
      gap: Math.round((forecast - supply) * 100) / 100, surgeBefore: surgeRaw(base, supply), surgeAfter: surgeRaw(forecast, supply) }
  })
}

export const METRICS: { key: MetricKey; label: string; unit: string; better: 'lower' | 'higher'; def: string }[] = [
  { key: 'matchWaitAvg', label: 'Match wait (avg)', unit: 'min', better: 'lower', def: 'accepted_at − requested_at, accepted requests' },
  { key: 'matchWaitMedian', label: 'Match wait (median)', unit: 'min', better: 'lower', def: 'median of the same interval' },
  { key: 'pickupWaitAvg', label: 'Pickup wait (avg)', unit: 'min', better: 'lower', def: 'pickup_at − requested_at, picked up within horizon' },
  { key: 'etaErrAvg', label: 'Pickup ETA error', unit: 'min', better: 'lower', def: '|actual pickup travel − predicted ETA|' },
  { key: 'utilization', label: 'Driver utilization', unit: '%', better: 'higher', def: 'Σ busy min (to pickup + trip) / Σ online min' },
  { key: 'completionRate', label: 'Completion rate', unit: '%', better: 'higher', def: 'completed within horizon / submitted' },
  { key: 'deadheadKm', label: 'Empty pickup km', unit: 'km', better: 'lower', def: 'Σ driver→pickup distance (deadhead only)' },
  { key: 'repoKm', label: 'Repositioning km', unit: 'km', better: 'lower', def: 'Σ proactive move distance (Urban Pulse only)' },
  { key: 'tripRange', label: 'Trips range', unit: '', better: 'lower', def: 'max − min trips per driver in this run' },
  { key: 'gini', label: 'Gini (trips)', unit: '', better: 'lower', def: 'Σ|xi−xj| / (2n²·mean); descriptive, not a fairness proof' },
]
