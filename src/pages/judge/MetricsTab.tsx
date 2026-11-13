import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { rpc } from '@/lib/supabase'

type M = {
  window: string; requested: number; completed: number; cancelled: number; no_driver_found: number; reassignments: number
  completion_rate: number | null; avg_match_wait_s: number | null; avg_pickup_wait_s: number | null; avg_pickup_eta_err_s: number | null
  reassigned_rides: number; reassignment_success_rate: number | null; avg_reassignment_delay_s: number | null; moves: Record<string, number>; safety_feedback: number; safety_reports_open: number
  drivers: { driver_id: string; name: string; trips_today: number; online: boolean; busy_min_24h: number; acceptance: number }[]
}
const na = (v: number | null | undefined, f: (n: number) => string, why: string) => (v == null ? <span title={why}>N/A<span className="block text-xs font-normal text-muted-foreground">{why}</span></span> : f(v))

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
    { k: 'Reassignment success', v: na(d.reassignment_success_rate, (n) => `${Math.round(n * 100)}%`, 'no failed offers yet'), def: `rides with a failed offer that later got a captain (${d.reassigned_rides} rides)` },
    { k: 'Reassignment delay', v: na(d.avg_reassignment_delay_s, (n) => `${n}s`, 'no recoveries yet'), def: 'first failure → next accepted offer' },
    { k: 'Repositioning (24h)', v: `${d.moves.arrived ?? 0} arrived`, def: Object.entries(d.moves).map(([k, n]) => `${n} ${k}`).join(' · ') || 'no moves yet' },
    { k: 'Safety', v: `${d.safety_feedback} feedback`, def: `${d.safety_reports_open} report(s) open or under review` },
  ]
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Window: {d.window}. Computed in SQL from stored timestamps and the event log. Time-based values are from a demo running at fast-demo speed.</p>
      <Card className="py-0">
        <dl className="grid grid-cols-2 lg:grid-cols-3">
          {tiles.map((t) => (
            <div key={t.k} className="border-b p-3 odd:border-r md:p-4 lg:odd:border-r-0 lg:[&:not(:nth-child(3n))]:border-r lg:[&:nth-last-child(-n+3)]:border-b-0">
              <dt className="text-xs text-muted-foreground">{t.k}</dt>
              <dd className="mt-0.5 text-xl font-semibold tabular-nums md:text-2xl">{t.v}</dd>
              <dd className="mt-1 text-xs leading-snug text-muted-foreground">{t.def}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Allocation spread across captains</CardTitle>
          <CardDescription>Trips today: min {Math.min(...trips)}, max {Math.max(...trips)}, range {Math.max(...trips) - Math.min(...trips)}. Descriptive only, not proof of fairness.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="rtable w-full min-w-[520px] text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-medium">Captain</th><th className="font-medium">Trips today</th><th className="font-medium">Busy min (24h)</th><th className="font-medium">Acceptance</th><th className="font-medium">Online</th></tr></thead>
            <tbody>{d.drivers.map((x) => (
              <tr key={x.driver_id} className="border-t">
                <td className="py-1.5">{x.name}</td>
                <td data-label="Trips today"><div className="flex items-center gap-2"><div className="h-2 w-24 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${(x.trips_today / Math.max(...trips, 1)) * 100}%` }} /></div><span className="tabular-nums">{x.trips_today}</span></div></td>
                <td data-label="Busy min (24h)" className="tabular-nums">{x.busy_min_24h}</td><td data-label="Acceptance" className="tabular-nums">{Math.round(x.acceptance * 100)}%</td><td data-label="Online">{x.online ? 'yes' : 'no'}</td>
              </tr>
            ))}</tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}
