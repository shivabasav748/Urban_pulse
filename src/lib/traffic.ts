import { useQuery } from '@tanstack/react-query'
import type { MapZone } from '@/components/map/MapCanvas'
import { rpc } from './supabase'

// Red = heavy (more expected riders than captains, or a peak), yellow = moderate, green = low. SIMULATED demand model.
export const TRAFFIC_COLOR = { heavy: '#dc2626', moderate: '#eab308', low: '#16a34a' } as const
const TEXT = { heavy: 'Busy: high demand, captains short', moderate: 'Moderate demand', low: 'Quiet: spare captains' }
type Row = { zone_id: number; name: string; lat: number; lng: number; level: keyof typeof TRAFFIC_COLOR; ratio: number }

const useRows = (enabled = true) =>
  useQuery({ queryKey: ['zone-traffic'], enabled, refetchInterval: 30_000, staleTime: 20_000, queryFn: () => rpc<Row[]>('zone_traffic') })

/** Level for one zone, plus a typical speed for it (SIMULATED: peak-hour assumption, not live traffic data). */
export function useTrafficLevel(zoneId?: number) {
  const level = useRows().data?.find((z) => z.zone_id === zoneId)?.level
  return level ? { level, label: { heavy: 'Heavy', moderate: 'Moderate', low: 'Light' }[level], kmh: { heavy: 10, moderate: 18, low: 28 }[level] } : undefined
}

export function useTraffic(enabled = true) {
  const q = useRows(enabled)
  const zones: MapZone[] = (q.data ?? []).map((z) => ({ id: z.zone_id, name: z.name, lat: z.lat, lng: z.lng, color: TRAFFIC_COLOR[z.level], note: TEXT[z.level], soft: true }))
  return zones
}
