import { useQuery } from '@tanstack/react-query'

export type LL = [number, number]
export type RoadRoute = { path: LL[]; road: boolean }

// Display only: fares and ETAs stay on the straight-line x 1.35 model. The public OSRM demo server gets two coordinates
// rounded to ~11 m (simulated demo trips); if it is slow or down we draw the straight line instead.
// ponytail: public OSRM demo server, self-host OSRM or use a licensed router for production traffic.
const r4 = (n: number) => Math.round(n * 1e4) / 1e4
async function fetchRoad(a: LL, b: LL): Promise<RoadRoute> {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${r4(a[1])},${r4(a[0])};${r4(b[1])},${r4(b[0])}?overview=full&geometries=geojson`
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    const j = await res.json()
    const coords: [number, number][] | undefined = j?.routes?.[0]?.geometry?.coordinates
    if (!coords?.length) throw new Error('no route')
    return { path: [a, ...coords.map(([lng, lat]) => [lat, lng] as LL), b], road: true }
  } catch {
    return { path: [a, b], road: false }
  }
}

export function useRoad(a?: LL | null, b?: LL | null) {
  return useQuery({
    queryKey: ['road', a && r4(a[0]), a && r4(a[1]), b && r4(b[0]), b && r4(b[1])],
    enabled: !!a && !!b, queryFn: () => fetchRoad(a!, b!),
    staleTime: Infinity, gcTime: 30 * 60_000, refetchInterval: false, retry: false,
  })
}

const rad = (d: number) => (d * Math.PI) / 180
export const meters = (a: LL, b: LL) => {
  const x = rad(b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2)), y = rad(b[0] - a[0])
  return Math.sqrt(x * x + y * y) * 6371000
}
export const bearing = (a: LL, b: LL) => {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]))
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]))
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** Point and heading at fraction f (0..1) of the path length. */
export function along(path: LL[], f: number): { p: LL; heading: number } {
  if (path.length < 2) return { p: path[0], heading: 0 }
  const seg = path.slice(1).map((q, i) => meters(path[i], q))
  let d = Math.max(0, Math.min(1, f)) * seg.reduce((s, x) => s + x, 0)
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, d / seg[i]) : 0, a = path[i], b = path[i + 1]
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b) }
    }
    d -= seg[i]
  }
  return { p: path[path.length - 1], heading: 0 }
}

/** Fraction of the path at the point nearest to p (snaps a live GPS position onto the road). */
export function fractionOf(path: LL[], p: LL): number {
  let best = Infinity, at = 0, run = 0, total = 0
  const seg = path.slice(1).map((q, i) => meters(path[i], q))
  total = seg.reduce((s, x) => s + x, 0)
  for (let i = 0; i < seg.length; i++) {
    const a = path[i], b = path[i + 1], dx = b[1] - a[1], dy = b[0] - a[0], L2 = dx * dx + dy * dy
    const t = L2 ? Math.max(0, Math.min(1, ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / L2)) : 0
    const d = meters(p, [a[0] + dy * t, a[1] + dx * t])
    if (d < best) { best = d; at = run + seg[i] * t }
    run += seg[i]
  }
  return total ? at / total : 0
}
