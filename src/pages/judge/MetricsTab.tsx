import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { rpc } from '@/lib/supabase'

type M = {
  window: string; requested: number; completed: number; cancelled: number; no_driver_found: number; reassignments: number
  completion_rate: number | null; avg_match_wait_s: number | null; avg_pickup_wait_s: number | null; avg_pickup_eta_err_s: number | null
  drivers: { driver_id: string; name: string; trips_today: number; online: boolean; busy_min_24h: number; acceptance: number }[]
}
const na = (v: number | null | undefined, f: (n: number) => string, why: string) => (v == null ? <span title={why}>N/A <span className="text-xs text-muted-foreground">({why})</span></span> : f(v))

export default function MetricsTab() {
  const m = useQuery({ queryKey: ['j-metrics'], queryFn: () => rpc<M>('admin_metrics') })
  if (m.isLoading) return <Skeleton className="h-60" />
  if (m.error || !m.data) return <p className="text-sm text-destructive">{m.error?.message}</p>
  const d = m.data
  const trips = d.drivers.map((x) => x.trips_today)
  const tiles = [
    { k: 'Avg match wait', v: na(d.avg_match_wait_s, (n) => `${n}s`, 'no accepted rides'), def: 'accepted_at − requested_at' },
    { k: 'Avg pickup wait', v: na(d.avg_pickup_wait_s, (n) => `${n}s`, 'no pickups yet'), def: 'started_at − requested_at' },
    { k: 'Pickup ETA error', v: na(d.avg_pickup_eta_err_s, (n) => `${n}s`, 'no pickups yet'), def: '|(started_at − accepted_at) − est. pickup ETA|' },
    { k: 'Completion rate', v: na(d.completion_rate, (n) => `${Math.round(n * 100)}%`, 'no finished rides'), def: 'completed / (completed + no driver + cancelled after accept)' },
    { k: 'Reassignments', v: d.reassignments, def: 'reject + timeout + captain cancel + delay events' },
    { k: 'Rides', v: `${d.completed}/${d.requested}`, def: `completed / requested · ${d.cancelled} cancelled · ${d.no_driver_found} no driver` },
  ]
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Window: {d.window}. Computed in SQL from stored timestamps and the event log. Time-based values are from a demo running at fast-demo speed.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <Card key={t.k}><CardContent className="p-4"><div className="text-xs text-muted-foreground">{t.k}</div><div className="text-2xl font-semibold tabular-nums">{t.v}</div><div className="mt-1 text-xs text-muted-foreground">{t.def}</div></CardContent></Card>
        ))}
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Allocation spread across captains</CardTitle>
          <CardDescription>Trips today: min {Math.min(...trips)}, max {Math.max(...trips)}, range {Math.max(...trips) - Math.min(...trips)}. Descriptive only, not proof of fairness.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-medium">Captain</th><th className="font-medium">Trips today</th><th className="font-medium">Busy min (24h)</th><th className="font-medium">Acceptance</th><th className="font-medium">Online</th></tr></thead>
            <tbody>{d.drivers.map((x) => (
              <tr key={x.driver_id} className="border-t">
                <td className="py-1.5">{x.name}</td>
                <td><div className="flex items-center gap-2"><div className="h-2 w-24 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${(x.trips_today / Math.max(...trips, 1)) * 100}%` }} /></div><span className="tabular-nums">{x.trips_today}</span></div></td>
                <td className="tabular-nums">{x.busy_min_24h}</td><td className="tabular-nums">{Math.round(x.acceptance * 100)}%</td><td>{x.online ? 'yes' : 'no'}</td>
              </tr>
            ))}</tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
