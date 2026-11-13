import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Loader2, Navigation, X } from 'lucide-react'
import { MapCanvas, type MapPin } from '@/components/map/MapCanvas'
import { AppHeader, CAT_LABEL, SimBadge, StatusChip } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth'
import { useLive, useSweep } from '@/lib/hooks'
import { rpc, supabase, type Ride, type RideStatus } from '@/lib/supabase'
import { inr } from '@/lib/geo'

type Stop = { ride_id: string; type: 'pickup' | 'drop'; label: string; lat: number; lng: number }
type Offer = { id: string; group_id: string; attempt_no: number; expires_at: string; score: number; components: { chosen: Record<string, number> }; summary: { pickup_km: number; pickup_min: number; stops: Stop[]; is_pool: boolean; fare: number } }
type Group = { id: string; status: RideStatus; stops: Stop[]; is_pool: boolean }

const NEXT: Partial<Record<RideStatus, { to: RideStatus; label: string }>> = {
  accepted: { to: 'arriving', label: 'Start driving to pickup' },
  arriving: { to: 'ongoing', label: 'Rider picked up · start trip' },
  ongoing: { to: 'completed', label: 'Complete trip' },
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t) }, [])
  const s = Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000))
  return <span className="tabular-nums" aria-live="off">{s}s</span>
}

export default function DriverPage() {
  const { session } = useAuth()
  const uid = session!.user.id
  const qc = useQueryClient()
  useSweep()
  useLive('ride_offers', [['offer', uid]], `driver_id=eq.${uid}`)
  useLive('trip_groups', [['group', uid], ['me', uid]], `driver_id=eq.${uid}`)
  useLive('rides', [['dhistory', uid]], `driver_id=eq.${uid}`)

  const me = useQuery({
    queryKey: ['me', uid],
    queryFn: async () => {
      const { data, error } = await supabase.from('driver_profiles').select('*').eq('user_id', uid).single()
      if (error) throw error
      return data as { online: boolean; lat: number; lng: number; vehicle_category: 'bike' | 'auto' | 'cab'; vehicle_label: string; plate: string; trips_today: number; offers_received: number; offers_accepted: number }
    },
  })
  const offer = useQuery({
    queryKey: ['offer', uid],
    queryFn: async () => {
      const { data } = await supabase.from('ride_offers').select('*').eq('driver_id', uid).eq('outcome', 'pending').maybeSingle()
      return data as Offer | null
    },
  })
  const group = useQuery({
    queryKey: ['group', uid],
    queryFn: async () => {
      const { data } = await supabase.from('trip_groups').select('id, status, stops, is_pool').eq('driver_id', uid).in('status', ['accepted', 'arriving', 'ongoing']).maybeSingle()
      return data as Group | null
    },
  })
  const history = useQuery({
    queryKey: ['dhistory', uid],
    queryFn: async () => {
      const { data } = await supabase.from('rides').select('*').eq('driver_id', uid).eq('status', 'completed').order('completed_at', { ascending: false }).limit(20)
      return (data ?? []) as Ride[]
    },
  })

  const onErr = (e: Error) => { toast.error(e.message); qc.invalidateQueries() }
  const toggle = useMutation({ mutationFn: (v: boolean) => rpc('set_online', { p_online: v }), onSuccess: () => qc.invalidateQueries({ queryKey: ['me', uid] }), onError: onErr })
  const respond = useMutation({
    mutationFn: (accept: boolean) => rpc('respond_offer', { p_offer: offer.data!.id, p_accept: accept }),
    onSuccess: (_d, accept) => { toast(accept ? 'Ride accepted' : 'Offer declined, sent to the next driver'); qc.invalidateQueries() },
    onError: onErr,
  })
  const advance = useMutation({ mutationFn: (to: RideStatus) => rpc('advance_trip', { p_group: group.data!.id, p_to: to }), onSuccess: () => qc.invalidateQueries(), onError: onErr })
  const cancelTrip = useMutation({ mutationFn: () => rpc('driver_cancel', { p_group: group.data!.id }), onSuccess: () => { toast('Trip released, reassigning to another driver'); qc.invalidateQueries() }, onError: onErr })

  const stops = group.data?.stops ?? offer.data?.summary.stops ?? []
  const pins: MapPin[] = stops.map((s, i) => ({ lat: s.lat, lng: s.lng, kind: stops.length > 2 ? 'stop' : s.type, label: `${s.type === 'pickup' ? 'Pickup' : 'Drop'}: ${s.label}`, text: stops.length > 2 ? String(i + 1) : undefined }))
  const meDrv = me.data ? [{ id: uid, lat: me.data.lat, lng: me.data.lng, label: 'You', category: me.data.vehicle_category, highlight: true }] : []
  const pts = [...meDrv.map((d) => [d.lat, d.lng] as [number, number]), ...pins.map((p) => [p.lat, p.lng] as [number, number])]
  const acc = me.data ? Math.round(((me.data.offers_accepted + 4) / (me.data.offers_received + 5)) * 100) : 0

  return (
    <div className="flex h-dvh flex-col">
      <AppHeader title="Captain"><SimBadge className="hidden sm:inline-flex" /></AppHeader>
      <div className="flex min-h-0 flex-1 flex-col-reverse md:flex-row">
        <aside className="z-[500] max-h-[62dvh] w-full shrink-0 overflow-y-auto border-t bg-background p-4 md:max-h-none md:w-[400px] md:border-r md:border-t-0">
          {me.isLoading ? <Skeleton className="h-16 w-full" /> : me.data && (
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="online" className="text-base">{me.data.online ? "You're online" : "You're offline"}</Label>
                <p className="text-xs text-muted-foreground">{CAT_LABEL[me.data.vehicle_category]} · {me.data.vehicle_label} · <span className="font-mono">{me.data.plate}</span></p>
              </div>
              <Switch id="online" checked={me.data.online} disabled={toggle.isPending || !!group.data} onCheckedChange={(v) => toggle.mutate(v)} />
            </div>
          )}
          <Tabs defaultValue="now" className="mt-4">
            <TabsList className="grid w-full grid-cols-2"><TabsTrigger value="now">Now</TabsTrigger><TabsTrigger value="history">Earnings &amp; history</TabsTrigger></TabsList>
            <TabsContent value="now" className="mt-4 space-y-4">
              {offer.data ? (
                <Card className="border-primary ring-1 ring-primary" role="alertdialog" aria-labelledby="offer-title">
                  <CardHeader className="pb-2">
                    <CardTitle id="offer-title" className="flex items-center justify-between text-base">
                      New {offer.data.summary.is_pool ? 'pooled ' : ''}ride request <span className="text-sm font-normal text-muted-foreground">expires in <Countdown until={offer.data.expires_at} /></span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <ol className="space-y-1 text-sm">
                      {offer.data.summary.stops.map((s, i) => (
                        <li key={i} className="flex gap-2"><span className={`mt-1.5 size-2 shrink-0 rounded-full ${s.type === 'pickup' ? 'bg-primary' : 'bg-foreground'}`} aria-hidden />{s.type === 'pickup' ? 'Pickup' : 'Drop'}: {s.label}</li>
                      ))}
                    </ol>
                    <div className="grid grid-cols-3 gap-2 text-center text-sm">
                      <div className="rounded-md bg-muted p-2"><div className="font-semibold tabular-nums">{Math.ceil(offer.data.summary.pickup_min)} min</div><div className="text-xs text-muted-foreground">to pickup</div></div>
                      <div className="rounded-md bg-muted p-2"><div className="font-semibold tabular-nums">{Number(offer.data.summary.pickup_km).toFixed(1)} km</div><div className="text-xs text-muted-foreground">away</div></div>
                      <div className="rounded-md bg-muted p-2"><div className="font-semibold tabular-nums">{inr(offer.data.summary.fare)}</div><div className="text-xs text-muted-foreground">est. fare</div></div>
                    </div>
                    <p className="text-xs text-muted-foreground">Why you: score {offer.data.score} (ETA {offer.data.components.chosen.c_eta}, workload {offer.data.components.chosen.c_workload}, reliability {offer.data.components.chosen.c_reliability}, idle {offer.data.components.chosen.c_idle}) · attempt {offer.data.attempt_no}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="outline" disabled={respond.isPending} onClick={() => respond.mutate(false)}><X className="size-4" aria-hidden />Decline</Button>
                      <Button disabled={respond.isPending} onClick={() => respond.mutate(true)}><Check className="size-4" aria-hidden />Accept</Button>
                    </div>
                  </CardContent>
                </Card>
              ) : group.data ? (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="flex items-center justify-between text-base">Current trip <StatusChip status={group.data.status} /></CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <ol className="space-y-1 text-sm">
                      {group.data.stops.map((s, i) => <li key={i}>{i + 1}. {s.type === 'pickup' ? 'Pickup' : 'Drop'}: {s.label}</li>)}
                    </ol>
                    {NEXT[group.data.status] && (
                      <Button className="h-11 w-full" disabled={advance.isPending} onClick={() => advance.mutate(NEXT[group.data!.status]!.to)}>
                        {advance.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Navigation className="size-4" aria-hidden />}{NEXT[group.data.status]!.label}
                      </Button>
                    )}
                    {['accepted', 'arriving'].includes(group.data.status) && (
                      <Button variant="ghost" className="w-full text-destructive" disabled={cancelTrip.isPending} onClick={() => cancelTrip.mutate()}>Cancel trip (reassigns rider)</Button>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                  {me.data?.online ? 'Waiting for ride requests nearby. Offers appear here automatically.' : 'Go online to start receiving ride requests.'}
                </p>
              )}
            </TabsContent>
            <TabsContent value="history" className="mt-4 space-y-3">
              {me.data && (
                <div className="grid grid-cols-3 gap-2 text-center text-sm">
                  <div className="rounded-md border p-2"><div className="font-semibold tabular-nums">{me.data.trips_today}</div><div className="text-xs text-muted-foreground">trips today</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold tabular-nums">{acc}%</div><div className="text-xs text-muted-foreground">acceptance</div></div>
                  <div className="rounded-md border p-2"><div className="font-semibold tabular-nums">{inr((history.data ?? []).reduce((s, r) => s + Number(r.fare.total), 0))}</div><div className="text-xs text-muted-foreground">fares (sim.)</div></div>
                </div>
              )}
              {!history.data?.length ? <p className="text-sm text-muted-foreground">No completed trips yet.</p> : history.data.map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                  <span className="min-w-0 truncate">{r.pickup_label} → {r.drop_label}</span><span className="tabular-nums">{inr(r.fare.total)}</span>
                </div>
              ))}
            </TabsContent>
          </Tabs>
        </aside>
        <div className="min-h-[38dvh] flex-1">
          <MapCanvas drivers={meDrv} pins={pins} route={pins.length >= 2 ? pins.map((p) => [p.lat, p.lng]) : undefined} fit={pts.length ? pts : undefined} />
        </div>
      </div>
    </div>
  )
}
