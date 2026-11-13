import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Loader2, LocateFixed, MapPinned, Navigation, Power, Users, Wallet, X } from 'lucide-react'
import { MapCanvas, type MapPin } from '@/components/map/MapCanvas'
import { MapShell } from '@/components/layout/MapShell'
import { Brand, CAT_LABEL, Empty, LoadError, SignOutButton, SimBadge, StatusChip } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/lib/auth'
import { useLive, usePhone, useSweep } from '@/lib/hooks'
import { rpc, supabase, type Ride, type RideStatus } from '@/lib/supabase'
import { inr } from '@/lib/geo'
import { GEO_MESSAGE, GOOD_ACCURACY_M, useCurrentPosition, useWatchPosition, type Fix, type GeoStatus } from '@/lib/geolocation'
import { inDemoArea } from '@/lib/places'
import { cn } from '@/lib/utils'

type Stop = { ride_id: string; type: 'pickup' | 'drop'; label: string; lat: number; lng: number }
type Offer = { id: string; group_id: string; attempt_no: number; offered_at: string; expires_at: string; score: number; components: { chosen: Record<string, number> }; summary: { pickup_km: number; pickup_min: number; stops: Stop[]; is_pool: boolean; fare: number } }
type Group = { id: string; status: RideStatus; stops: Stop[]; is_pool: boolean }

const NEXT: Partial<Record<RideStatus, { to: RideStatus; label: string; title: string }>> = {
  accepted: { to: 'arriving', label: 'Start driving to pickup', title: 'Head to pickup' },
  arriving: { to: 'ongoing', label: 'Rider picked up · start trip', title: 'Pick up your rider' },
  ongoing: { to: 'completed', label: 'Complete trip', title: 'On trip' },
}

/** Depleting bar + seconds left. The bar is decorative; the number is the accessible value. */
function Countdown({ from, until }: { from: string; until: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t) }, [])
  const start = new Date(from).getTime(), end = new Date(until).getTime()
  const left = Math.max(0, end - now), pct = Math.max(0, Math.min(100, (left / Math.max(end - start, 1)) * 100))
  const s = Math.ceil(left / 1000)
  return (
    <div className="space-y-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={cn('h-full rounded-full', s <= 5 ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%`, transition: 'width 250ms linear' }} />
      </div>
      <p className="text-right text-xs text-muted-foreground tabular-nums">{s > 0 ? `Expires in ${s}s` : 'Expired, passing to the next captain'}</p>
    </div>
  )
}

const StopList = ({ stops, numbered }: { stops: Stop[]; numbered?: boolean }) => (
  <ol className="relative space-y-3 pl-6 text-sm" aria-label="Stops">
    <span className="absolute top-2 bottom-2 left-[4px] w-px bg-foreground/20" aria-hidden />
    {stops.map((s, i) => (
      <li key={i} className="relative">
        <span className={cn('absolute top-1.5 -left-6 size-2.5', s.type === 'pickup' ? 'rounded-full bg-primary' : 'rounded-[3px] bg-foreground')} aria-hidden />
        <span className="text-xs text-muted-foreground">{numbered ? `${i + 1}. ` : ''}{s.type === 'pickup' ? 'Pickup' : 'Drop'}</span>
        <div>{s.label}</div>
      </li>
    ))}
  </ol>
)

export default function DriverPage() {
  const { session } = useAuth()
  const uid = session!.user.id
  const qc = useQueryClient()
  const phone = usePhone()
  const [earningsOpen, setEarningsOpen] = useState(false)
  useSweep()
  useLive('ride_offers', [['offer', uid]], `driver_id=eq.${uid}`)
  useLive('trip_groups', [['group', uid], ['me', uid]], `driver_id=eq.${uid}`)
  useLive('rides', [['dhistory', uid]], `driver_id=eq.${uid}`)

  const me = useQuery({
    queryKey: ['me', uid],
    queryFn: async () => {
      const { data, error } = await supabase.from('driver_profiles').select('*').eq('user_id', uid).single()
      if (error) throw error
      return data as { online: boolean; lat: number; lng: number; location_updated_at: string | null; location_source: string; vehicle_category: 'bike' | 'auto' | 'cab'; vehicle_label: string; plate: string; trips_today: number; offers_received: number; offers_accepted: number }
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

  // ---- location: requested only when the captain chooses to go online; stops when offline or on sign-out ----
  const geo = useCurrentPosition()
  const [locMode, setLocMode] = useState<'gps' | 'manual' | null>(null)
  const [locError, setLocError] = useState<string | null>(null)
  const sendLoc = (lat: number, lng: number, accuracy: number | null, source: 'gps' | 'manual') =>
    rpc('update_location', { p_lat: lat, p_lng: lng, p_accuracy_m: accuracy, p_source: source })
      .then(() => { setLocError(null); qc.invalidateQueries({ queryKey: ['me', uid] }) })
      .catch((e: Error) => setLocError(e.message.replace(/^validation: /, '')))
  const online = !!me.data?.online
  const watch = useWatchPosition(online && locMode === 'gps', (f) => { void sendLoc(f.lat, f.lng, f.accuracy, 'gps') })
  const watchLast = useRef<Fix | null>(null)
  watchLast.current = watch.last
  // Reloaded while already online: keep the last known position as a manual pin (no surprise permission prompt).
  useEffect(() => { if (online && locMode === null) setLocMode('manual') }, [online, locMode])
  useEffect(() => { if (!online) setLocMode(null) }, [online])
  // Heartbeat: dispatch only uses positions refreshed within the server's freshness window (90 s).
  useEffect(() => {
    if (!online || !locMode || !me.data) return
    const beat = () => {
      if (locMode === 'manual') { void sendLoc(me.data!.lat, me.data!.lng, null, 'manual'); return }
      const f = watchLast.current ?? geo.fix // never downgrade a GPS captain to "manual" for lack of a fresh fix
      if (f) void sendLoc(f.lat, f.lng, f.accuracy, 'gps')
    }
    beat()
    const t = setInterval(beat, 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, locMode])

  const goOnline = async (mode: 'gps' | 'manual') => {
    if (mode === 'gps') {
      const f = await geo.request()
      if (!f) return // panel shows the reason and the manual option
      if (!inDemoArea(f.lat, f.lng)) { setLocError('You are outside the Bengaluru demo area. Go online with a manual position instead.'); return }
      await sendLoc(f.lat, f.lng, f.accuracy, 'gps')
    } else if (me.data) {
      await sendLoc(me.data.lat, me.data.lng, null, 'manual')
    }
    setLocMode(mode)
    toggle.mutate(true)
  }
  const respond = useMutation({
    mutationFn: (accept: boolean) => rpc('respond_offer', { p_offer: offer.data!.id, p_accept: accept }),
    onSuccess: (_d, accept) => { if (!accept) toast('Declined. The request went to the next captain.'); qc.invalidateQueries() },
    onError: onErr,
  })
  const advance = useMutation({ mutationFn: (to: RideStatus) => rpc('advance_trip', { p_group: group.data!.id, p_to: to }), onSuccess: () => qc.invalidateQueries(), onError: onErr })
  const cancelTrip = useMutation({ mutationFn: () => rpc('driver_cancel', { p_group: group.data!.id }), onSuccess: () => { toast('Trip released. Reassigning your rider.'); qc.invalidateQueries() }, onError: onErr })

  const stops = group.data?.stops ?? offer.data?.summary.stops ?? []
  const pins: MapPin[] = stops.map((s, i) => ({ lat: s.lat, lng: s.lng, kind: stops.length > 2 ? 'stop' : s.type, label: `${s.type === 'pickup' ? 'Pickup' : 'Drop'}: ${s.label}`, text: stops.length > 2 ? String(i + 1) : undefined }))
  const meDrv = me.data ? [{ id: uid, lat: me.data.lat, lng: me.data.lng, label: 'You', category: me.data.vehicle_category, highlight: true }] : []
  const pts = [...meDrv.map((d) => [d.lat, d.lng] as [number, number]), ...pins.map((p) => [p.lat, p.lng] as [number, number])]
  const acc = me.data ? Math.round(((me.data.offers_accepted + 4) / (me.data.offers_received + 5)) * 100) : 0
  const earned = (history.data ?? []).reduce((s, r) => s + Number(r.fare.total), 0)
  const o = offer.data, g = group.data, next = g ? NEXT[g.status] : undefined

  const footer = me.isLoading || me.error ? undefined : o ? (
    <div className="flex gap-2">
      <Button variant="outline" className="h-14 flex-1 text-[15px]" disabled={respond.isPending} onClick={() => respond.mutate(false)}><X className="size-5" aria-hidden />Decline</Button>
      <Button className="h-14 flex-[2] text-[15px]" disabled={respond.isPending} onClick={() => respond.mutate(true)}>
        {respond.isPending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Check className="size-5" aria-hidden />}Accept
      </Button>
    </div>
  ) : g ? (next && (
    <Button className="h-14 w-full text-[15px]" disabled={advance.isPending} onClick={() => advance.mutate(next.to)}>
      {advance.isPending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Navigation className="size-5" aria-hidden />}{next.label}
    </Button>
  )) : me.data && (me.data.online ? (
    <Button variant="outline" className="h-14 w-full text-[15px]" disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>
      {toggle.isPending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Power className="size-5" aria-hidden />}Go offline
    </Button>
  ) : (
    <Button className="h-14 w-full text-[15px]" disabled={toggle.isPending || geo.status === 'locating'} onClick={() => goOnline('gps')}>
      {toggle.isPending || geo.status === 'locating' ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Power className="size-5" aria-hidden />}
      {geo.status === 'locating' ? 'Getting your location…' : 'Go online'}
    </Button>
  ))

  return (
    <>
      <MapShell label={o ? 'Incoming ride request' : g ? 'Current trip' : 'Captain status'} footer={footer}
        topLeft={<><Brand compact /><SimBadge className="hidden sm:inline-flex" /></>}
        topRight={<>
          <SimBadge className="mr-1 sm:hidden" />
          <Button variant="ghost" size="sm" className="h-8 rounded-full" onClick={() => setEarningsOpen(true)} aria-label="Earnings and history">
            <Wallet className="size-4" aria-hidden /><span className="hidden sm:inline">Earnings</span>
          </Button>
          <SignOutButton className="size-8 rounded-full" />
        </>}
        map={<MapCanvas panel drivers={meDrv} pins={pins} route={pins.length >= 2 ? pins.map((p) => [p.lat, p.lng]) : undefined} fit={pts.length ? pts : undefined}
          onPick={online && locMode === 'manual' && !g ? (lat, lng) => { if (inDemoArea(lat, lng)) void sendLoc(lat, lng, null, 'manual') } : undefined} />}>
        {me.isLoading ? (
          <div className="space-y-3 pt-1"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-56" /><Skeleton className="h-20 w-full rounded-2xl" /></div>
        ) : me.error ? (
          <LoadError what="your captain profile" error={me.error} retry={() => me.refetch()} />
        ) : o ? (
          <div role="alertdialog" aria-labelledby="offer-title" aria-describedby="offer-summary" className="space-y-4 pt-1">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 id="offer-title" className="text-xl font-semibold tracking-tight">New {o.summary.is_pool ? 'pooled ' : ''}ride request</h1>
                <p id="offer-summary" className="text-sm text-muted-foreground tabular-nums">
                  {Math.ceil(o.summary.pickup_min)} min · {Number(o.summary.pickup_km).toFixed(1)} km to pickup
                </p>
              </div>
              <div className="text-right"><div className="text-3xl leading-none font-semibold tabular-nums">{inr(o.summary.fare)}</div><div className="mt-1 text-xs text-muted-foreground">est. fare</div></div>
            </div>
            <Countdown from={o.offered_at} until={o.expires_at} />
            {o.summary.is_pool && <p className="flex items-center gap-1.5 text-sm text-info"><Users className="size-4" aria-hidden />Two riders share this trip</p>}
            <StopList stops={o.summary.stops} numbered={o.summary.is_pool} />
            <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Why you:</span> ranked first on score {o.score} (ETA {o.components.chosen.c_eta}, workload {o.components.chosen.c_workload}, reliability {o.components.chosen.c_reliability}, idle {o.components.chosen.c_idle}). Attempt {o.attempt_no}.
            </p>
          </div>
        ) : g ? (
          <div className="space-y-4 pt-1">
            <div className="flex items-start justify-between gap-3">
              <h1 className="text-xl font-semibold tracking-tight">{next?.title ?? 'Current trip'}</h1>
              <StatusChip status={g.status} short />
            </div>
            <StopList stops={g.stops} numbered={g.is_pool} />
            {['accepted', 'arriving'].includes(g.status) && (
              <Button variant="ghost" size="sm" className="-ml-2 text-destructive hover:text-destructive" disabled={cancelTrip.isPending} onClick={() => cancelTrip.mutate()}>
                Cancel trip · your rider is reassigned
              </Button>
            )}
          </div>
        ) : me.data && (
          <div className="space-y-4 pt-1">
            <div className="flex items-center gap-3">
              <span className={cn('relative grid size-3 place-items-center')} aria-hidden>
                {me.data.online && <span className="absolute size-3 rounded-full bg-success/40 motion-safe:animate-ping" />}
                <span className={cn('size-3 rounded-full', me.data.online ? 'bg-success' : 'bg-muted-foreground/40')} />
              </span>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">{me.data.online ? "You're online" : "You're offline"}</h1>
                <p className="text-sm text-muted-foreground">{me.data.online ? 'Ride requests near you appear here.' : 'Going online shares your location so nearby requests reach you, and shows it to your rider during a trip.'}</p>
              </div>
            </div>
            <dl className="grid grid-cols-3 divide-x rounded-2xl bg-muted/60 py-3 text-center">
              <div><dt className="text-xs text-muted-foreground">Trips today</dt><dd className="text-lg font-semibold tabular-nums">{me.data.trips_today}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Acceptance</dt><dd className="text-lg font-semibold tabular-nums">{acc}%</dd></div>
              <div><dt className="text-xs text-muted-foreground">Vehicle</dt><dd className="text-lg font-semibold">{CAT_LABEL[me.data.vehicle_category]}</dd></div>
            </dl>
            <p className="text-xs text-muted-foreground">{me.data.vehicle_label} · <span className="font-mono">{me.data.plate}</span></p>
            <LocationStatus online={me.data.online} mode={locMode} geoStatus={me.data.online ? watch.status : geo.status} fix={watch.last ?? geo.fix}
              updatedAt={me.data.location_updated_at} error={locError} onManual={() => goOnline('manual')} onRetryGps={() => (me.data!.online ? setLocMode('gps') : goOnline('gps'))} />
          </div>
        )}
      </MapShell>

      <Sheet open={earningsOpen} onOpenChange={setEarningsOpen}>
        <SheetContent side={phone ? 'bottom' : 'right'} className={cn(phone && 'max-h-[85dvh] rounded-t-3xl pb-[env(safe-area-inset-bottom)]')}>
          <SheetHeader>
            <SheetTitle>Earnings</SheetTitle>
            <SheetDescription>Completed trips. Fares are simulated estimates.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            <dl className="grid grid-cols-2 gap-2">
              <div className="rounded-2xl bg-muted/60 p-3"><dt className="text-xs text-muted-foreground">Fares (last 20 trips)</dt><dd className="text-2xl font-semibold tabular-nums">{inr(earned)}</dd></div>
              <div className="rounded-2xl bg-muted/60 p-3"><dt className="text-xs text-muted-foreground">Trips today</dt><dd className="text-2xl font-semibold tabular-nums">{me.data?.trips_today ?? 0}</dd></div>
            </dl>
            {history.isLoading ? <Skeleton className="h-24 w-full" /> : !history.data?.length ? <Empty>No completed trips yet.</Empty> : (
              <ul className="divide-y">
                {history.data.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-3 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.drop_label}</span>
                      <span className="block truncate text-xs text-muted-foreground">from {r.pickup_label}{r.completed_at && ` · ${new Date(r.completed_at).toLocaleTimeString([], { timeStyle: 'short' })}`}</span>
                    </span>
                    <span className="font-semibold tabular-nums">{inr(r.fare.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

/** Where the captain's position comes from, how good it is, and what to do when it fails. */
function LocationStatus({ online, mode, geoStatus, fix, updatedAt, error, onManual, onRetryGps }: {
  online: boolean; mode: 'gps' | 'manual' | null; geoStatus: GeoStatus; fix: Fix | null; updatedAt: string | null
  error: string | null; onManual: () => void; onRetryGps: () => void
}) {
  const failed = ['denied', 'unavailable', 'timeout', 'unsupported', 'insecure'].includes(geoStatus)
  const age = updatedAt ? Math.round((Date.now() - new Date(updatedAt).getTime()) / 1000) : null
  return (
    <div className="space-y-2 rounded-2xl bg-muted/60 p-3 text-sm" aria-live="polite">
      {online && mode === 'gps' && !failed && (
        <p className="flex items-center gap-2"><LocateFixed className="size-4 text-primary" aria-hidden />
          {fix ? <>GPS · ±{fix.accuracy} m{age != null && ` · sent ${age}s ago`}</> : 'Waiting for a GPS fix…'}</p>
      )}
      {online && mode === 'gps' && fix && fix.accuracy > GOOD_ACCURACY_M && (
        <p className="text-xs text-warning">Accuracy is above {GOOD_ACCURACY_M} m, so you won't be matched until it improves. Move to open sky, or use a manual position.</p>
      )}
      {online && mode === 'manual' && (
        <p className="flex items-center gap-2"><MapPinned className="size-4 text-muted-foreground" aria-hidden />Manual position · tap the map to move it{age != null && ` · refreshed ${age}s ago`}</p>
      )}
      {failed && <p className="text-xs text-muted-foreground">{GEO_MESSAGE[geoStatus]}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {(failed || error || (online && mode === 'manual')) && (
        <div className="flex flex-wrap gap-2">
          {!(online && mode === 'manual') && <Button size="sm" variant="outline" onClick={onManual}><MapPinned className="size-4" aria-hidden />{online ? 'Use manual position' : 'Go online with a manual position'}</Button>}
          {geoStatus !== 'unsupported' && geoStatus !== 'insecure' && <Button size="sm" variant="ghost" onClick={onRetryGps}><LocateFixed className="size-4" aria-hidden />Use GPS</Button>}
        </div>
      )}
      {!online && !failed && !error && <p className="text-xs text-muted-foreground">Your position stops being used the moment you go offline.</p>}
    </div>
  )
}
