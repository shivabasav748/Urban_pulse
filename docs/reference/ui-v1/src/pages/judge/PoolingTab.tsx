import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Merge, PlusCircle } from 'lucide-react'
import { MapCanvas } from '@/components/map/MapCanvas'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { planPool, POOL, type PoolRide } from '@/lib/pooling'
import { PLACES } from '@/lib/places'
import { inr } from '@/lib/geo'
import { rpc, supabase, type Ride } from '@/lib/supabase'
import { cn } from '@/lib/utils'

const P = (id: string) => PLACES.find((p) => p.id === id)!
// pickups ~0.7 km apart, drops ~0.6 km apart; compatibility is checked by planPool (see lib.test.ts)
const DEMO_PAIR = [['rani-channamma-circle', 'tilakwadi'], ['khade-bazar', 'rpd-ground']] as const

export default function PoolingTab() {
  const qc = useQueryClient()
  const rides = useQuery({
    queryKey: ['j-groups', 'pool-candidates'],
    queryFn: async () => ((await supabase.from('rides').select('*').in('status', ['requested', 'no_driver_found']).order('requested_at', { ascending: false }).limit(20)).data ?? []) as Ride[],
  })
  const riders = useQuery({ queryKey: ['riders'], queryFn: async () => (await supabase.from('profiles').select('id, display_name').eq('role', 'rider').order('display_name')).data ?? [] })
  const [picked, setPicked] = useState<string[]>([])
  const sel = rides.data?.filter((r) => picked.includes(r.id)) ?? []
  const toPool = (r: Ride): PoolRide => ({ id: r.id, pickup: { lat: r.pickup_lat, lng: r.pickup_lng, label: r.pickup_label }, drop: { lat: r.drop_lat, lng: r.drop_lng, label: r.drop_label } })
  const plan = useMemo(() => (sel.length === 2 ? planPool(toPool(sel[0]), toPool(sel[1]), 12) : null), [sel])

  const seed = useMutation({
    mutationFn: async () => {
      const rs = riders.data?.filter((r) => r.display_name !== 'Asha (rider)') ?? []
      if (rs.length < 2) throw new Error('Need two seeded riders')
      return Promise.all(DEMO_PAIR.map(([a, b], i) => rpc<string>('demo_request', {
        p_rider: rs[i].id, p_pickup_label: P(a).name, p_lat: P(a).lat, p_lng: P(a).lng, p_drop_label: P(b).name, d_lat: P(b).lat, d_lng: P(b).lng, p_category: 'cab', p_dispatch: false,
      })))
    },
    onSuccess: (ids) => { setPicked(ids); qc.invalidateQueries(); toast.success('Two compatible requests created (not yet dispatched)') },
    onError: (e) => toast.error(e.message),
  })
  const pool = useMutation({
    mutationFn: () => rpc<string>('create_pool', { p_rides: picked, p_stops: plan!.stops, p_detours: Object.fromEntries(plan!.perRider!.map((p) => [p.id, p.detourPct])) }),
    onSuccess: () => { setPicked([]); qc.invalidateQueries(); toast.success('Pooled trip group created and dispatched to one cab') },
    onError: (e) => toast.error(e.message),
  })

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]))
  const stops = plan?.stops ?? []
  const soloTotal = plan?.perRider?.reduce((s, r) => s + r.soloFare.total, 0) ?? 0
  const pooledTotal = plan?.perRider?.reduce((s, r) => s + r.pooledFare, 0) ?? 0

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Waiting requests</CardTitle>
          <CardDescription>Pick two. Compatible when pickups ≤ {POOL.maxPickupKm} km, drops ≤ {POOL.maxDropKm} km apart and each detour ≤ {POOL.maxDetourPct}%.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button variant="outline" className="w-full" disabled={seed.isPending} onClick={() => seed.mutate()}><PlusCircle className="size-4" aria-hidden />Create 2 compatible demo requests</Button>
          {!rides.data?.length && <p className="text-sm text-muted-foreground">No undispatched requests.</p>}
          {rides.data?.map((r) => (
            <label key={r.id} className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm', picked.includes(r.id) && 'border-primary bg-primary/5')}>
              <input type="checkbox" className="mt-1" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
              <span>{r.pickup_label} → {r.drop_label}<span className="block text-xs text-muted-foreground">{r.category} · solo {inr(r.fare.total)} · {r.status}</span></span>
            </label>
          ))}
        </CardContent>
      </Card>
      <div className="space-y-4">
        {!plan ? <p className="rounded-md bg-background p-4 text-sm text-muted-foreground">Select two requests to evaluate a pool.</p>
          : !plan.compatible ? <Alert variant="destructive"><AlertDescription>Not poolable: {plan.reason}.</AlertDescription></Alert>
          : (
            <>
              <Card className="overflow-hidden p-0">
                <div className="h-[320px]">
                  <MapCanvas pins={stops.map((s, i) => ({ lat: s.lat, lng: s.lng, kind: 'stop' as const, text: String(i + 1), label: `${i + 1}. ${s.type} · ${s.label}` }))}
                    route={stops.map((s) => [s.lat, s.lng] as [number, number])} fit={stops.map((s) => [s.lat, s.lng] as [number, number])} />
                </div>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Pooled vs separate rides (calculated)</CardTitle>
                  <CardDescription>Exhaustive search over the 6 valid stop orders (each pickup before its drop); chose the minimum total time within the detour cap. Straight-line × 1.35 legs, no traffic.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <ol className="flex flex-wrap gap-2">{stops.map((s, i) => (
                    <li key={i} className="rounded-md border px-2 py-1"><b>{i + 1}</b> {s.type === 'pickup' ? 'Pick up' : 'Drop'} {s.label}</li>
                  ))}</ol>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="rounded-md border p-2"><div className="text-xs text-muted-foreground">Vehicle time</div><b className="tabular-nums">{plan.pooledMin} min</b> pooled vs {plan.separateMin} min separate</div>
                    <div className="rounded-md border p-2"><div className="text-xs text-muted-foreground">Vehicles needed</div><b>1</b> vs 2</div>
                    <div className="rounded-md border p-2"><div className="text-xs text-muted-foreground">Riders pay</div><b className="tabular-nums">{inr(pooledTotal)}</b> vs {inr(soloTotal)}</div>
                  </div>
                  <table className="rtable w-full text-sm">
                    <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-medium">Rider</th><th className="font-medium">Solo</th><th className="font-medium">Pooled</th><th className="font-medium">Added</th><th className="font-medium">Fare</th></tr></thead>
                    <tbody>{plan.perRider!.map((p) => {
                      const r = sel.find((x) => x.id === p.id)!
                      return (
                        <tr key={p.id} className="border-t">
                          <td className="py-1.5">{r.pickup_label} → {r.drop_label}</td>
                          <td data-label="Solo" className="tabular-nums">{p.soloMin} min</td><td data-label="Pooled" className="tabular-nums">{p.pooledMin} min</td>
                          <td data-label="Added" className="tabular-nums">+{p.addedMin} min ({p.detourPct}%)</td>
                          <td data-label="Fare" className="tabular-nums">{inr(p.pooledFare)} <span className="text-xs text-success">saves {p.savedPct}%</span></td>
                        </tr>
                      )
                    })}</tbody>
                  </table>
                  <Button disabled={pool.isPending} onClick={() => pool.mutate()}><Merge className="size-4" aria-hidden />Create pool and dispatch one cab</Button>
                  <p className="text-xs text-muted-foreground">The server re-checks distances and detour caps, moves both rides into one trip group, then dispatches. One captain, one active trip group.</p>
                </CardContent>
              </Card>
            </>
          )}
      </div>
    </div>
  )
}
