// Dispatch Arena: deterministic A/B/C simulator. Pure functions, no I/O, no Math.random. All values SIMULATED.
// See docs/DISPATCH_ARENA.md for the metric dictionary and docs/DISPATCH_ALGORITHM.md for the policies.
import { scoreDrivers, type Policy } from '@/lib/allocation'
import { fare, km, minutes, type LatLng } from '@/lib/geo'
import { costPerKm, DEFAULT_VEHICLE, rideEconomics } from '@/lib/economics'
import { surgeRaw } from '@/lib/surge'
import forecastJson from './forecast.json'

export const ALGORITHM_VERSION = 'arena-v3 (A nearest · B score .45/.25/.20/.10 + greedy 15-min moves · C zone-aware w_zone .15 + planner every 5 min: hysteresis, cooldown, finishing-trip supply, 15-min move cap; shifts/breaks; fare model v2)'

type FcKey = 'base' | 'rush_hour' | 'heavy_rain' | 'concert_end' | 'airport_wave'
type ScenarioDef = {
  label: string; startHour: number; how: string; fc: FcKey; group: 'efficiency' | 'reassignment' | 'safety'
  hotspot?: { lat: number; lng: number; perBucket: number; buckets: number }  // extra requests the forecast does not know about
  emptyZones?: number[]                  // no captains start in these zones
  zoneMult?: Record<number, number>      // deterministic demand adjustment per zone (labelled, not a model feature)
  demandScale?: number                   // deterministic demand adjustment, all zones
  abandonMin?: number                    // riders give up after this many minutes unmatched (default 10)
  fleetSize?: number                     // default 28 cabs
  accept?: [number, number]              // captain acceptance probability range (default .55-.95)
  offlineShare?: number                  // share of captains who log off mid-run (deterministic times)
  prefShare?: number; optinShare?: number // women-driver preference: requests asking for it / captains opted in
}
export type ScenarioId = 'base' | 'morning_peak' | 'evening_peak' | 'rush_hour' | 'station_spike' | 'airport_wave' | 'zone_shortage'
  | 'multi_reject' | 'captain_offline' | 'women_pref_ok' | 'women_pref_short' | 'heavy_rain' | 'concert_end'
  | 'weekend' | 'hospital_demand' | 'festival' | 'multi_zone_shortage' | 'high_cancellation' | 'high_density' | 'low_density'
export const ARENA_SCENARIOS: Record<ScenarioId, ScenarioDef> = {
  base: { label: 'Normal weekday (midday)', startHour: 12, how: 'model forecast', fc: 'base', group: 'efficiency' },
  morning_peak: { label: 'Morning peak (08:00)', startHour: 8, how: 'model forecast', fc: 'base', group: 'efficiency' },
  evening_peak: { label: 'Evening peak (17:30)', startHour: 17.5, how: 'model forecast', fc: 'base', group: 'efficiency' },
  rush_hour: { label: 'Evening rush, office zones ×1.6', startHour: 17.5, how: 'deterministic adjustment, not a model feature', fc: 'rush_hour', group: 'efficiency' },
  station_spike: { label: 'Sudden spike at the railway station', startHour: 18, how: 'unforecast extra requests (live data only)', fc: 'base', group: 'efficiency',
    hotspot: { lat: 15.84906, lng: 74.50894, perBucket: 7, buckets: 2 } },
  airport_wave: { label: 'Airport demand spike (flight wave)', startHour: 5.5, how: 'model feature: scheduled event', fc: 'airport_wave', group: 'efficiency' },
  zone_shortage: { label: 'One zone starts with no captains (Nehru Nagar)', startHour: 18, how: 'fleet placement', fc: 'base', group: 'efficiency', emptyZones: [3] },
  multi_zone_shortage: { label: 'Several zones start with no captains (Nehru Nagar, Udyambag, VTU)', startHour: 18, how: 'fleet placement', fc: 'base', group: 'efficiency', emptyZones: [3, 5, 6] },
  weekend: { label: 'Weekend afternoon (offices quiet, nightlife busier)', startHour: 15, how: 'deterministic adjustment: office zones x0.5, Tilakwadi x1.3', fc: 'base', group: 'efficiency', zoneMult: { 3: 0.5, 5: 0.5, 6: 0.5, 2: 1.3 } },
  hospital_demand: { label: 'Hospital visiting-hours demand (KLE Hospital)', startHour: 16, how: 'unforecast extra requests near KLE Hospital', fc: 'base', group: 'efficiency',
    hotspot: { lat: 15.8879, lng: 74.51992, perBucket: 5, buckets: 3 } },
  festival: { label: 'Festival evening (city centre, Tilakwadi, Vadgaon x1.5)', startHour: 18, how: 'deterministic adjustment (synthetic festival, not a real date)', fc: 'base', group: 'efficiency', zoneMult: { 1: 1.5, 2: 1.5, 4: 1.5 } },
  high_cancellation: { label: 'Impatient riders (give up after 4 min)', startHour: 18, how: 'rider patience 4 min instead of 10', fc: 'base', group: 'reassignment', abandonMin: 4 },
  high_density: { label: 'High fleet density (60 cabs)', startHour: 18, how: 'fleet size', fc: 'base', group: 'efficiency', fleetSize: 60 },
  low_density: { label: 'Low fleet density (14 cabs)', startHour: 18, how: 'fleet size', fc: 'base', group: 'efficiency', fleetSize: 14 },
  multi_reject: { label: 'Many captain rejections', startHour: 18, how: 'acceptance 25-55%', fc: 'base', group: 'reassignment', accept: [0.25, 0.55] },
  captain_offline: { label: 'Captains going offline during offers', startHour: 18, how: '30% log off mid-run', fc: 'base', group: 'reassignment', offlineShare: 0.3 },
  women_pref_ok: { label: 'Women-driver preference, adequate supply', startHour: 18, how: '30% of requests, 45% of captains opted in', fc: 'base', group: 'safety', prefShare: 0.3, optinShare: 0.45 },
  women_pref_short: { label: 'Women-driver preference, insufficient supply', startHour: 18, how: '30% of requests, 10% of captains opted in', fc: 'base', group: 'safety', prefShare: 0.3, optinShare: 0.1 },
  heavy_rain: { label: 'Heavy rain (Khade Bazar, Tilakwadi, Vadgaon)', startHour: 17, how: 'model feature: rain', fc: 'heavy_rain', group: 'efficiency' },
  concert_end: { label: 'Match ends at KSCA Stadium', startHour: 21.5, how: 'model feature: scheduled event', fc: 'concert_end', group: 'efficiency' },
}

const ZONES = [ // Belagavi zone centres (OpenStreetMap); same ids/kinds as the model
  { id: 1, lat: 15.86112, lng: 74.51492 }, { id: 2, lat: 15.83686, lng: 74.50193 }, { id: 3, lat: 15.8879, lng: 74.51992 },
  { id: 4, lat: 15.83359, lng: 74.52421 }, { id: 5, lat: 15.81746, lng: 74.49263 }, { id: 6, lat: 15.7773, lng: 74.46486 },
  { id: 7, lat: 15.88564, lng: 74.54633 }, { id: 8, lat: 15.86308, lng: 74.61119 },
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
export const nearestZone = (p: LatLng) => ZONES.reduce((b, z) => (km(p, z) < km(p, b) ? z : b)).id

// ---------- input ----------
/** onAt: shift start (some captains log in late); breakFrom/breakTo: a short break; offlineAt: logs off for good. */
export type SimDriver = LatLng & { id: string; tripsToday: number; offersReceived: number; offersAccepted: number; idleMin: number; acceptProb: number; optin: boolean
  offlineAt: number | null; onAt: number; breakFrom: number | null; breakTo: number | null }
export type SimRequest = { id: string; t: number; pickup: LatLng; drop: LatLng; zone: number; rolls: number[]; etaNoise: number; pref: boolean }
export type ScenarioInput = { runId: string; seed: number; scenario: ScenarioId; startHour: number; horizonMin: number; tickMin: number; fleet: SimDriver[]; requests: SimRequest[]; algorithmVersion: string }

export function generateInput(seed: number, scenario: ScenarioId, fleetSizeArg?: number, horizonMin = 120, demandScale = 1): ScenarioInput {
  const def = ARENA_SCENARIOS[scenario]
  const fleetSize = fleetSizeArg ?? def.fleetSize ?? 28
  const rng = mulberry32(seed)
  const extra = mulberry32(seed ^ 0x5bd1e995) // scenario-specific draws never shift the shared stream
  const [aLo, aHi] = def.accept ?? [0.55, 0.95]
  const homes = ZONES.filter((z) => !def.emptyZones?.includes(z.id))
  const fleet: SimDriver[] = Array.from({ length: fleetSize }, (_, i) => {
    const z = homes[i % homes.length]
    const received = 10, u = rng()
    const acceptProb = aLo + (aHi - aLo) * u
    const pos = jitter(rng, z, 1.2)
    return { id: `D${String(i + 1).padStart(2, '0')}`, ...pos, tripsToday: Math.floor(rng() * 8),
      offersReceived: received, offersAccepted: Math.round(acceptProb * received), idleMin: Math.round(rng() * 30), acceptProb,
      optin: extra() < (def.optinShare ?? 0), offlineAt: extra() < (def.offlineShare ?? 0) ? Math.round(10 + extra() * 90) : null, onAt: 0, breakFrom: null, breakTo: null }
  })
  // availability realism (separate stream, so request streams are unchanged): ~15% start late, ~25% take a 20-min break
  const avail = mulberry32(seed ^ 0x2545f491)
  for (const d of fleet) {
    if (avail() < 0.15) d.onAt = Math.round(5 + avail() * 35)
    if (avail() < 0.25) { const b = Math.round(20 + avail() * 70); d.breakFrom = b; d.breakTo = b + 20 }
  }
  const requests: SimRequest[] = []
  const add = (t: number, pickup: LatLng, zone: number) => {
    let drop = jitter(rng, pickup, 7)
    if (km(pickup, drop) < 2) drop = jitter(rng, pickup, 7)
    requests.push({ id: '', t, pickup, drop, zone, rolls: Array.from({ length: 8 }, rng), etaNoise: 0.85 + 0.4 * rng(), pref: extra() < (def.prefShare ?? 0) })
  }
  for (let b = 0; b < horizonMin / 30; b++) {
    const bucket = Math.floor(def.startHour * 2) + b
    for (const z of ZONES) {
      const n = poisson(rng, (FC[def.fc][String(z.id)][bucket % 48] ?? 0) * (def.zoneMult?.[z.id] ?? 1) * (def.demandScale ?? 1) * demandScale)
      for (let k = 0; k < n; k++) { const pickup = jitter(rng, z, 1.2); add(Math.round((b * 30 + rng() * 30) * 2) / 2, pickup, z.id) }
    }
    if (def.hotspot && b < def.hotspot.buckets) {
      const n = poisson(extra, def.hotspot.perBucket)
      for (let k = 0; k < n; k++) { const pickup = jitter(extra, def.hotspot, 0.5); add(Math.round((b * 30 + extra() * 30) * 2) / 2, pickup, nearestZone(pickup)) }
    }
  }
  requests.sort((a, b) => a.t - b.t || a.zone - b.zone || a.pickup.lat - b.pickup.lat)
  requests.forEach((r, i) => (r.id = `R${String(i + 1).padStart(3, '0')}`))
  return { runId: `run-${seed}-${scenario}`, seed, scenario, startHour: def.startHour, horizonMin, tickMin: 0.5, fleet, requests, algorithmVersion: ALGORITHM_VERSION }
}

// ---------- world ----------
type DState = SimDriver & { freeAt: number; busyMin: number; deadheadKm: number; repoKm: number; assigned: number; holding: boolean
  moveTo?: number; moveFrom?: number; arriveAt?: number; lastMoveAt: number; lastOrigin?: number; lastArriveAt?: number }
type RState = { req: SimRequest; excluded: Set<string>; offer?: { driver: string; decideAt: number; outcome: 'accept' | 'reject' | 'no_response'; etaMin: number; dhKm: number }
  attempts: number; firstFailAt?: number; acceptedAt?: number; pickupAt?: number; completeAt?: number; predictedEta?: number; actualEta?: number
  status: 'waiting' | 'offered' | 'assigned' | 'unserved' }

export type WorldKind = 'nearest' | 'urban_pulse' | 'zone_aware'
export type MetricKey = 'matchWaitAvg' | 'matchWaitMedian' | 'pickupWaitAvg' | 'etaErrAvg' | 'utilization' | 'completionRate' | 'deadheadKm'
  | 'zoneImbalance' | 'reassignSuccess' | 'reassignDelay' | 'moves' | 'unnecessaryMoves' | 'repoKm' | 'tripRange' | 'gini'
  | 'prefServed' | 'prefWait' | 'prefViolations' | 'cancelRate' | 'driverNetPerHour'
export type WorldResult = {
  kind: WorldKind; policy: Policy; reposition: boolean
  metrics: Record<MetricKey, number | null>
  counts: { submitted: number; completed: number; inFlight: number; unserved: number; reassignments: number; prefRequests: number; fleet: number }
  perDriver: { id: string; assigned: number; busyMin: number }[]
  timeline: { t: number; served: number; waiting: number }[]
}

const RESPONSE_MIN = 0.5, TIMEOUT_MIN = 1.5, ABANDON_MIN = 10, RADIUS_KM = 8
const COOLDOWN_MIN = 10, MAX_MOVE_KM = 8 * 1.35, PLAN_EVERY = 5, MAX_MOVE_MIN = 15 // zone-aware planner (mirrors settings in SQL)
export const SHORTLIST = 8
export type WorldOptions = { batch?: boolean; maxMoveMin?: number; shortlist?: number; planner?: 'greedy' | 'zone' | 'none' }

export function runWorld(input: ScenarioInput, kind: WorldKind, reposition = true, opts: WorldOptions = {}): WorldResult {
  const maxMoveMin = opts.maxMoveMin ?? MAX_MOVE_MIN
  const planner = opts.planner ?? (kind === 'urban_pulse' ? 'greedy' : kind === 'zone_aware' ? 'zone' : 'none')
  const abandon = ARENA_SCENARIOS[input.scenario].abandonMin ?? ABANDON_MIN
  const def = ARENA_SCENARIOS[input.scenario]
  const policy: Policy = kind
  const hour = (t: number) => (input.startHour + t / 60) % 24
  const drivers: DState[] = input.fleet.map((d) => ({ ...d, freeAt: 0, busyMin: 0, deadheadKm: 0, repoKm: 0, assigned: 0, holding: false, lastMoveAt: -1e9 }))
  const reqs: RState[] = input.requests.map((req) => ({ req, excluded: new Set(), attempts: 0, status: 'waiting' }))
  let reassignments = 0, moves = 0, unnecessary = 0
  const imbalance: number[] = []
  const timeline: WorldResult['timeline'] = []
  const online = (d: DState, t: number) => t >= d.onAt && (d.offlineAt == null || t < d.offlineAt) && !(d.breakFrom != null && t >= d.breakFrom && t < d.breakTo!)
  let netEarnings = 0
  const fcNext = (z: number, t: number) => FC[def.fc][String(z)][Math.floor(input.startHour * 2 + (t + 30) / 30) % 48] ?? 0

  /** live zone balance: waiting requests + next-bucket forecast vs free captains (+ those en route) */
  const balance = (t: number) => {
    const free = drivers.filter((d) => d.freeAt <= t && !d.holding && online(d, t))
    return ZONES.map((z) => {
      const waiting = reqs.filter((r) => (r.status === 'waiting' || r.status === 'offered') && r.req.t <= t && r.req.zone === z.id).length
      const avail = free.filter((d) => nearestZone(d) === z.id).length
      const incoming = drivers.filter((d) => d.moveTo === z.id && (d.arriveAt ?? 0) > t).length
      // captains finishing a trip that drops in this zone within 30 min (mirrors zone_balance.finishing in SQL)
      const finishing = drivers.filter((d) => d.moveTo == null && d.freeAt > t && d.freeAt <= t + 30 && online(d, t) && nearestZone(d) === z.id).length
      const demand = fcNext(z.id, t) + waiting
      const expected = avail + incoming + finishing
      return { z, demand, avail, incoming, finishing, expected, shortage: demand - expected }
    })
  }

  for (let t = 0; t <= input.horizonMin; t += input.tickMin) {
    const free = () => drivers.filter((d) => d.freeAt <= t && !d.holding && online(d, t))
    // arrivals of repositioning moves: was the move still useful? did it undo a recent move?
    for (const d of drivers) {
      if (d.moveTo == null || d.arriveAt == null || d.arriveAt > t) continue
      const b = balance(t).find((x) => x.z.id === d.moveTo)!
      if (b.demand - (b.avail - 1) < 0.5) unnecessary++                      // target was not short when the captain got there
      else if (d.lastOrigin === d.moveTo && t - (d.lastArriveAt ?? -1e9) < 30) unnecessary++  // oscillation back within 30 min
      d.lastOrigin = d.moveFrom; d.lastArriveAt = t; d.moveTo = undefined; d.arriveAt = undefined
    }
    // resolve offers due now (or immediately if the captain went offline while holding one)
    for (const r of reqs) {
      if (r.status !== 'offered' || !r.offer) continue
      const d = drivers.find((x) => x.id === r.offer!.driver)!
      const wentOffline = !online(d, t)
      if (!wentOffline && r.offer.decideAt > t) continue
      d.holding = false
      if (!wentOffline && r.offer.outcome === 'accept') {
        const actualEta = r.offer.etaMin * r.req.etaNoise
        const trip = minutes(km(r.req.pickup, r.req.drop), 'cab', hour(t))
        Object.assign(r, { status: 'assigned', acceptedAt: t, predictedEta: r.offer.etaMin, actualEta, pickupAt: t + actualEta, completeAt: t + actualEta + trip })
        d.offersAccepted++; d.assigned++; d.tripsToday++
        d.busyMin += Math.min(actualEta + trip, input.horizonMin - t); d.deadheadKm += r.offer.dhKm
        d.freeAt = t + actualEta + trip; d.lat = r.req.drop.lat; d.lng = r.req.drop.lng; d.idleMin = 0
        d.moveTo = undefined; d.arriveAt = undefined
        const tripKm = km(r.req.pickup, r.req.drop), f = fare('cab', tripKm)
        netEarnings += rideEconomics({ category: 'cab', fareTotal: f.total, gst: f.gst, tripKm, pickupKm: r.offer.dhKm, tripMin: trip, pickupMin: actualEta }).driverNet
      } else {
        r.excluded.add(d.id); r.status = 'waiting'; r.offer = undefined; reassignments++; r.firstFailAt ??= t
      }
    }
    // repositioning
    if (reposition && planner === 'greedy' && t % 15 === 0) {
      // B: the existing greedy planner (forecast only, no cooldown, captains unavailable while moving)
      const bucket = Math.floor(input.startHour * 2 + (t + 30) / 30) % 48
      const idle = free()
      const supply = new Map<number, DState[]>(ZONES.map((z) => [z.id, idle.filter((d) => nearestZone(d) === z.id)]))
      const fc = (z: number) => FC[def.fc][String(z)][bucket] ?? 0
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
          pick.moveFrom = from; pick.moveTo = z.id; pick.arriveAt = t + mins; pick.lastMoveAt = t + mins; moves++
        }
      }
    }
    if (reposition && planner === 'zone' && t % PLAN_EVERY === 0) {
      // C: mirrors _reposition_tick: live waiting + forecast, shortage >= 1 targets, donors keep >= 1 spare, cooldown, distance cap
      const bal = balance(t)
      const out = new Map<number, number>()
      for (const tgt of [...bal].filter((b) => b.shortage >= 1).sort((a, b) => b.shortage - a.shortage || a.z.id - b.z.id)) {
        for (let k = 0; k < Math.floor(tgt.shortage); k++) {
          const donors = free().filter((d) => {
            const zid = nearestZone(d), src = bal.find((b) => b.z.id === zid)!
            return zid !== tgt.z.id && d.moveTo == null && t - d.lastMoveAt >= COOLDOWN_MIN && km(d, tgt.z) <= MAX_MOVE_KM
              && minutes(km(d, tgt.z), 'cab', hour(t)) <= maxMoveMin   // the 30-min forecast must still apply on arrival
              && src.expected - Math.ceil(src.demand) - (out.get(zid) ?? 0) >= 1
          })
          const pick = donors.sort((a, b) => km(a, tgt.z) - km(b, tgt.z) || a.id.localeCompare(b.id))[0]
          if (!pick) break
          const from = nearestZone(pick)
          out.set(from, (out.get(from) ?? 0) + 1)
          const dist = km(pick, tgt.z), mins = minutes(dist, 'cab', hour(t))
          pick.repoKm += dist; pick.freeAt = t + mins; pick.lat = tgt.z.lat; pick.lng = tgt.z.lng
          pick.moveFrom = from; pick.moveTo = tgt.z.id; pick.arriveAt = t + mins; pick.lastMoveAt = t + mins; moves++
        }
      }
    }
    if (t % 5 === 0) {
      const bal = balance(t)
      imbalance.push(bal.reduce((s, b) => s + Math.abs(b.shortage), 0) / bal.length)
    }
    // abandon + match waiting requests: FIFO one at a time (live system), or a global min-ETA assignment per tick (batch)
    const slack = kind === 'zone_aware' ? new Map(balance(t).map((b) => [b.z.id, -b.shortage])) : null
    const offer = (r: RState, d: DState, etaMin: number, dhKm: number) => {
      const roll = r.req.rolls[Math.min(r.attempts, r.req.rolls.length - 1)]
      const outcome = roll < d.acceptProb ? 'accept' : roll < d.acceptProb + (1 - d.acceptProb) / 2 ? 'reject' : 'no_response'
      r.attempts++; d.offersReceived++; d.holding = true; r.status = 'offered'
      r.offer = { driver: d.id, decideAt: t + (outcome === 'no_response' ? TIMEOUT_MIN : RESPONSE_MIN), outcome, etaMin, dhKm }
    }
    if (opts.batch) {
      const waiting = reqs.filter((r) => r.status === 'waiting' && r.req.t <= t)
      for (const r of waiting) if (t - r.req.t > abandon) r.status = 'unserved'
      const open = waiting.filter((r) => r.status === 'waiting'), pool = free()
      if (open.length && pool.length) {
        const BIG = 1e6
        const cost = open.map((r) => pool.map((d) => {
          const k = km(d, r.req.pickup)
          return r.excluded.has(d.id) || (r.req.pref && !d.optin) || k > RADIUS_KM ? BIG : minutes(k, 'cab', hour(t))
        }))
        const match = assign(cost, BIG)
        match.forEach((j, i) => { if (j >= 0) offer(open[i], pool[j], cost[i][j], km(pool[j], open[i].req.pickup)) })
      }
    }
    for (const r of opts.batch ? [] : reqs) {
      if (r.status !== 'waiting' || r.req.t > t) continue
      if (t - r.req.t > abandon) { r.status = 'unserved'; continue }
      const cands = free().filter((d) => !r.excluded.has(d.id) && (!r.req.pref || d.optin))  // preference = hard constraint
        .map((d) => ({ d, k: km(d, r.req.pickup) })).filter((x) => x.k <= RADIUS_KM)
        // shortlist the nearest captains before scoring (mirrors _rank in SQL): with a wide candidate spread, min-max
        // normalised ETA stops discriminating and workload/idle would pull captains from far away
        .sort((a, b) => a.k - b.k || a.d.id.localeCompare(b.d.id)).slice(0, opts.shortlist ?? SHORTLIST)
      if (!cands.length) continue
      const ranked = scoreDrivers(cands.map(({ d, k }) => ({ id: d.id, pickupMin: minutes(k, 'cab', hour(t)), tripsToday: d.tripsToday,
        idleMin: d.idleMin + Math.max(0, t - d.freeAt), offersAccepted: d.offersAccepted, offersReceived: d.offersReceived,
        zoneSlack: slack?.get(nearestZone(d)) })), policy)
      const best = ranked[0], d = drivers.find((x) => x.id === best.id)!
      offer(r, d, best.pickupMin, cands.find((c) => c.d === d)!.k)
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
  const failed = reqs.filter((r) => r.firstFailAt != null)
  const recovered = failed.filter((r) => r.acceptedAt != null)
  const pref = reqs.filter((r) => r.req.pref)
  const onlineMin = drivers.reduce((s, d) => s + Math.max(0, Math.min(d.offlineAt ?? input.horizonMin, input.horizonMin) - d.onAt
    - (d.breakFrom != null && d.breakFrom < input.horizonMin ? Math.min(d.breakTo!, input.horizonMin) - d.breakFrom : 0)), 0)
  const repoCost = drivers.reduce((s, d) => s + d.repoKm * costPerKm(DEFAULT_VEHICLE.cab).total, 0)
  const prefViolations = acc.filter((r) => r.req.pref && !drivers.find((d) => d.id === r.offer?.driver)?.optin).length

  return {
    kind, policy, reposition: reposition && kind !== 'nearest', timeline,
    metrics: {
      matchWaitAvg: r2(avg(acc.map((r) => r.acceptedAt! - r.req.t))),
      matchWaitMedian: r2(median(acc.map((r) => r.acceptedAt! - r.req.t))),
      pickupWaitAvg: r2(avg(picked.map((r) => r.pickupAt! - r.req.t))),
      etaErrAvg: r2(avg(picked.map((r) => Math.abs(r.actualEta! - r.predictedEta!)))),
      utilization: r2(drivers.reduce((s, d) => s + d.busyMin, 0) / Math.max(onlineMin, 1)),
      completionRate: reqs.length ? r2(completed / reqs.length) : null,
      deadheadKm: r2(drivers.reduce((s, d) => s + d.deadheadKm, 0)),
      zoneImbalance: r2(avg(imbalance)),
      reassignSuccess: failed.length ? r2(recovered.length / failed.length) : null,
      reassignDelay: r2(avg(recovered.map((r) => r.acceptedAt! - r.firstFailAt!))),
      moves, unnecessaryMoves: moves ? unnecessary : 0,
      repoKm: r2(drivers.reduce((s, d) => s + d.repoKm, 0)),
      tripRange: Math.max(...counts) - Math.min(...counts),
      gini: r2(gini),
      prefServed: pref.length ? r2(pref.filter((r) => r.acceptedAt != null).length / pref.length) : null,
      prefWait: r2(avg(pref.filter((r) => r.acceptedAt != null).map((r) => r.acceptedAt! - r.req.t))),
      prefViolations: pref.length ? prefViolations : null,
      cancelRate: reqs.length ? r2(reqs.filter((r) => r.status === 'unserved').length / reqs.length) : null,
      driverNetPerHour: onlineMin ? r2((netEarnings - repoCost) / (onlineMin / 60)) : null,
    },
    counts: { submitted: reqs.length, completed, inFlight: acc.length - completed, unserved: reqs.filter((r) => r.status === 'unserved').length, reassignments, prefRequests: pref.length, fleet: drivers.length },
    perDriver: drivers.map((d) => ({ id: d.id, assigned: d.assigned, busyMin: Math.round(d.busyMin) })),
  }
}

export type ArenaRun = { input: ScenarioInput; baseline: WorldResult; urbanPulse: WorldResult; zoneAware: WorldResult; ranAt: string }
export function runArena(seed: number, scenario: ScenarioId, reposition = true, fleetSize?: number, demandScale = 1): ArenaRun {
  const input = generateInput(seed, scenario, fleetSize, 120, demandScale)
  return {
    input,
    baseline: runWorld(structuredClone(input), 'nearest', false),
    urbanPulse: runWorld(structuredClone(input), 'urban_pulse', reposition),
    zoneAware: runWorld(structuredClone(input), 'zone_aware', reposition),
    ranAt: new Date().toISOString(),
  }
}

/** What-If chain at the scenario start: forecast -> supply gap -> surge (shared formula). */
export function scenarioChain(input: ScenarioInput) {
  const def = ARENA_SCENARIOS[input.scenario]
  const bucket = Math.floor(input.startHour * 2) % 48
  return ZONES.map((z) => {
    const forecast = FC[def.fc][String(z.id)][bucket], base = FC.base[String(z.id)][bucket]
    const supply = input.fleet.filter((d) => nearestZone(d) === z.id).length
    return { zone: z.id, base: Math.round(base * 100) / 100, forecast: Math.round(forecast * 100) / 100, supply,
      gap: Math.round((forecast - supply) * 100) / 100, surgeBefore: surgeRaw(base, supply), surgeAfter: surgeRaw(forecast, supply) }
  })
}

export type MetricGroup = 'passenger' | 'fleet' | 'zones' | 'reassignment' | 'fairness' | 'preference'
export const METRICS: { key: MetricKey; label: string; unit: string; better: 'lower' | 'higher'; def: string; group: MetricGroup }[] = [
  { key: 'matchWaitAvg', label: 'Passenger wait to match (avg)', unit: 'min', better: 'lower', def: 'accepted_at − requested_at, accepted requests', group: 'passenger' },
  { key: 'matchWaitMedian', label: 'Wait to match (median)', unit: 'min', better: 'lower', def: 'median of the same interval', group: 'passenger' },
  { key: 'pickupWaitAvg', label: 'Wait until pickup (avg)', unit: 'min', better: 'lower', def: 'pickup_at − requested_at, picked up within horizon', group: 'passenger' },
  { key: 'etaErrAvg', label: 'Pickup ETA error', unit: 'min', better: 'lower', def: '|actual pickup travel − predicted ETA|', group: 'passenger' },
  { key: 'completionRate', label: 'Ride completion rate', unit: '%', better: 'higher', def: 'completed within horizon / submitted', group: 'passenger' },
  { key: 'utilization', label: 'Captain utilisation', unit: '%', better: 'higher', def: 'Σ busy min (to pickup + trip) / Σ online min', group: 'fleet' },
  { key: 'deadheadKm', label: 'Empty pickup distance', unit: 'km', better: 'lower', def: 'Σ captain→pickup distance (deadhead only)', group: 'fleet' },
  { key: 'zoneImbalance', label: 'Zone demand–supply imbalance', unit: '', better: 'lower', def: 'mean over 5-min snapshots of mean |demand_30 − expected supply| per zone', group: 'zones' },
  { key: 'moves', label: 'Repositioning moves', unit: '', better: 'lower', def: 'count of proactive zone moves (cost, not a goal)', group: 'zones' },
  { key: 'unnecessaryMoves', label: 'Unnecessary zone switches', unit: '', better: 'lower', def: 'moves whose target was no longer short on arrival, or that undid a move within 30 min', group: 'zones' },
  { key: 'repoKm', label: 'Repositioning distance', unit: 'km', better: 'lower', def: 'Σ proactive move distance', group: 'zones' },
  { key: 'reassignSuccess', label: 'Reassignment success', unit: '%', better: 'higher', def: 'requests with ≥1 failed offer that were later accepted / requests with ≥1 failed offer', group: 'reassignment' },
  { key: 'reassignDelay', label: 'Reassignment delay', unit: 'min', better: 'lower', def: 'accepted_at − first failure, recovered requests', group: 'reassignment' },
  { key: 'tripRange', label: 'Trips per captain (range)', unit: '', better: 'lower', def: 'max − min trips per captain in this run', group: 'fairness' },
  { key: 'gini', label: 'Workload Gini', unit: '', better: 'lower', def: 'Σ|xi−xj| / (2n²·mean); descriptive, not a fairness proof', group: 'fairness' },
  { key: 'prefServed', label: 'Preference requests served', unit: '%', better: 'higher', def: 'accepted / requests asking for a woman driver', group: 'preference' },
  { key: 'prefWait', label: 'Preference wait to match', unit: 'min', better: 'lower', def: 'accepted_at − requested_at for preference requests', group: 'preference' },
  { key: 'cancelRate', label: 'Rider gave up (cancellation rate)', unit: '%', better: 'lower', def: 'requests unmatched past rider patience / submitted', group: 'passenger' },
  { key: 'driverNetPerHour', label: 'Captain net earnings per online hour', unit: '₹/h', better: 'higher', def: 'Σ(80% of fare ex-GST − vehicle cost of trip + pickup km) − repositioning km cost, ÷ online hours (fare model v2, Dzire CNG base costs)', group: 'fleet' },
  { key: 'prefViolations', label: 'Preference violations', unit: '', better: 'lower', def: 'preference requests accepted by a captain who is not opted in (must be 0)', group: 'preference' },
]

/** Rectangular min-cost assignment (Hungarian algorithm with potentials, O(n^2 m)). Rows = requests, columns = captains.
 *  Returns, per row, the assigned column or -1 when the best available pairing is infeasible (cost >= big). */
export function assign(cost: number[][], big = 1e6): number[] {
  const n = cost.length, m = cost[0]?.length ?? 0
  if (!n || !m) return Array(n).fill(-1)
  const transpose = n > m
  const a = transpose ? Array.from({ length: m }, (_, j) => cost.map((row) => row[j])) : cost
  const N = a.length, M = a[0].length
  const u = new Array(N + 1).fill(0), v = new Array(M + 1).fill(0), p = new Array(M + 1).fill(0), way = new Array(M + 1).fill(0)
  for (let i = 1; i <= N; i++) {
    p[0] = i; let j0 = 0
    const minv = new Array(M + 1).fill(Infinity), used = new Array(M + 1).fill(false)
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0
      for (let j = 1; j <= M; j++) if (!used[j]) {
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= M; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta } else minv[j] -= delta
      j0 = j1
    } while (p[j0] !== 0)
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1 } while (j0)
  }
  const rowToCol = new Array(N).fill(-1)
  for (let j = 1; j <= M; j++) if (p[j]) rowToCol[p[j] - 1] = j - 1
  const out = new Array(n).fill(-1)
  if (transpose) rowToCol.forEach((req, cap) => { if (req >= 0 && cost[req][cap] < big) out[req] = cap })
  else rowToCol.forEach((cap, req) => { if (cap >= 0 && cost[req][cap] < big) out[req] = cap })
  return out
}
