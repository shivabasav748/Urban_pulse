import { useMemo } from 'react'
import { MapCanvas } from '@/components/map/MapCanvas'
import { StatusChip } from '@/components/ride/bits'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { fmtTime, routeLabel, useActiveGroupIds, useDrivers, useEvents, useGroups } from './data'

export default function LiveTab() {
  const drivers = useDrivers(), busy = useActiveGroupIds(), groups = useGroups(), events = useEvents()
  const online = drivers.data?.filter((d) => d.online) ?? []
  const mapDrivers = useMemo(() => online.map((d) => ({ id: d.user_id, lat: d.lat, lng: d.lng, label: d.profiles.display_name, category: d.vehicle_category, busy: busy.data?.has(d.user_id) })), [online, busy.data])
  const active = groups.data?.filter((g) => ['requested', 'offered', 'accepted', 'arriving', 'ongoing'].includes(g.status)) ?? []

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card className="overflow-hidden p-0">
        <div className="h-[520px]"><MapCanvas drivers={mapDrivers} pins={active.flatMap((g) => g.stops.slice(0, 1).map((s) => ({ ...s, kind: 'pickup' as const, label: `${s.label} (${g.status})` })))} /></div>
        <div className="flex flex-wrap gap-4 border-t p-3 text-xs text-muted-foreground">
          <span><b className="text-foreground">{online.length}</b> online captains</span>
          <span><b className="text-foreground">{busy.data?.size ?? 0}</b> on a trip</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-full bg-[#0f766e]" />cab</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-full bg-[#7c3aed]" />auto</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-full bg-[#d97706]" />bike</span>
          <span className="flex items-center gap-1"><span className="size-2.5 rounded-full bg-slate-400" />busy</span>
        </div>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Active rides ({active.length})</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {groups.isLoading ? <Skeleton className="h-16" /> : !active.length ? <p className="text-sm text-muted-foreground">No active rides. Book one as the rider, or use Chaos Mode → "Create demo ride".</p>
              : active.map((g) => (
                <div key={g.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">{g.is_pool && <b>POOL · </b>}{routeLabel(g)}</span><StatusChip status={g.status} />
                </div>
              ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Event log (append-only)</CardTitle></CardHeader>
          <CardContent>
            <ol className="max-h-[300px] space-y-1 overflow-y-auto font-mono text-xs">
              {events.data?.length ? events.data.map((e) => (
                <li key={e.id} className="flex gap-2"><span className="text-muted-foreground">{fmtTime(e.at)}</span><span>{e.type}</span>
                  {e.to_status && <span className="text-muted-foreground">→ {e.to_status}</span>}</li>
              )) : <li className="font-sans text-muted-foreground">No events yet.</li>}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
