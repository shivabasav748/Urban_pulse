import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowRight, Car, Check, CheckCircle2, Clock, Compass, Loader2, LocateFixed, MapPin, MapPinned, Navigation, Power, ShieldCheck, TrendingUp, Users, Wallet, X } from 'lucide-react'
import { MapCanvas, TrafficLegend, ZONE_STATE_COLOR, type MapPin as Pin } from '@/components/map/MapCanvas'
import { ActionBar, MapFirstLayout } from '@/components/layout/AppShell'
import { CAT_LABEL, Empty, Eyebrow, LoadError, Panel, SimBadge, StatusChip, Tag, friendly } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/lib/auth'
import { ContactButton } from '@/components/ride/Contact'
import { TRAFFIC_COLOR, useTraffic, useTrafficLevel } from '@/lib/traffic'
import { useLive, usePhone, useSweep } from '@/lib/hooks'
import { rpc, supabase, type Ride, type RideStatus } from '@/lib/supabase'
import { ROAD_FACTOR, inr, km } from '@/lib/geo'
import { rideEconomics } from '@/lib/economics'
import { GEO_MESSAGE, GOOD_ACCURACY_M, useCurrentPosition, useWatchPosition, type Fix, type GeoStatus } from '@/lib/geolocation'
import { inDemoArea } from '@/lib/places'
import { safetyLabel, type SafetySummary, type ZoneState } from '@/lib/zones'
import { cn } from '@/lib/utils'

type Stop = { ride_id: string; type: 'pickup' | 'drop'; label: string; lat: number; lng: number }
type Offer = { id: string; group_id: string; attempt_no: number; offered_at: string; expires_at: string; score: number; components: { chosen: Record<string, number> }
  summary: { pickup_km: number; pickup_min: number; stops: Stop[]; is_pool: boolean; fare: number; women_driver_pref?: boolean } }
type Group = { id: string; status: RideStatus; stops: Stop[]; is_pool: boolean }
type Me = { online: boolean; lat: number; lng: number; location_updated_at: string | null; location_source: string; vehicle_category: 'bike' | 'auto' | 'cab'
  vehicle_label: string; plate: string; trips_today: number; offers_received: number; offers_accepted: number; idle_since: string | null; is_simulated: boolean }
type ZoneRow = { zone_id: number; name: string; state: ZoneState; demand_30: number; expected_supply: number; shortage: number; peak: boolean; rising: boolean; km: number; eta_min: number; current: boolean }
type Move = { id: string; to_zone: number; to_name: string; status: 'recommended' | 'accepted'; source: 'system' | 'captain'; reason: { text?: string }; km: number; eta_min: number; simulated: boolean; expires_at: string }
type ZoneView = { physical_zone: number; physical_zone_name: string; op_zone: number; op_zone_name: string; location_ok: boolean; online: boolean
  open_move: Move | null; cooldown_min_left: number; blocked_reason: string | null; zones: ZoneRow[] }

const NEXT: Partial<Record<RideStatus, { to: RideStatus; label: string; title: string }>> = {
  accepted: { to: 'arriving', label: 'Start driving to pickup', title: 'Head to pickup' },
  arriving: { to: 'ongoing', label: 'Rider picked up · start trip', title: 'Arrived at pickup' },
  ongoing: { to: 'completed', label: 'Complete trip (confirm drop)', title: 'Navigating to drop' },
}
const BLOCKED: Record<string, string> = {
  go_online_first: 'Go online to switch zones.', location_not_fresh: 'Your location needs a fresh fix before switching zones.',
  on_trip: 'Finish your current trip first.', respond_to_offer: 'Answer the ride request first.', cooldown: 'You changed zone recently.',
}
const STATE_TONE = { undersupplied: 'danger', balanced: 'info', oversupplied: 'success' } as const
const STATE_TEXT = { undersupplied: 'Needs captains', balanced: 'Balanced', oversupplied: 'Plenty of captains' }

/** Depleting bar + seconds left. The bar is decorative; the number is the accessible value. */
function useSecondsLeft(from: string, until: string) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t) }, [])
  const start = new Date(from).getTime(), end = new Date(until).getTime()
  const left = Math.max(0, end - now)
  return { s: Math.ceil(left / 1000), pct: Math.max(0, Math.min(100, (left / Math.max(end - start, 1)) * 100)) }
}

const StopList = ({ stops, numbered }: { stops: Stop[]; numbered?: boolean }) => (
  <ol className="space-y-3 rounded-2xl border bg-surface p-3 text-sm" aria-label="Stops">
    {stops.map((s, i) => (
      <li key={i} className="flex items-start gap-2.5">
        {s.type === 'pickup' ? <MapPin className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> : <Navigation className="mt-0.5 size-4 shrink-0 text-rose-600" aria-hidden />}
        <div className="min-w-0"><div className="text-[10px] font-bold tracking-wide text-slate-500 uppercase">{numbered ? `${i + 1}. ` : ''}{s.type === 'pickup' ? 'Pickup' : 'Destination'}</div><div className="font-semibold">{s.label}</div></div>
      </li>
    ))}
  </ol>
)

export default function DriverPage() {
  const { session, profile } = useAuth()
  const uid = session!.user.id
  const qc = useQueryClient()
  const phone = usePhone()
  const [earningsOpen, setEarningsOpen] = useState(false)
  useSweep()
  useLive('ride_offers', [['offer', uid]], `driver_id=eq.${uid}`)
  useLive('trip_groups', [['group', uid], ['me', uid]], `driver_id=eq.${uid}`)
  useLive('rides', [['dhistory', uid]], `driver_id=eq.${uid}`)
  useLive('reposition_moves', [['zone-view', uid]], `driver_id=eq.${uid}`)

  const me = useQuery({
    queryKey: ['me', uid],
    queryFn: async () => {
      const { data, error } = await supabase.from('driver_profiles').select('*').eq('user_id', uid).single()
      if (error) throw error
      return data as Me
    },
  })
  const offer = useQuery({ queryKey: ['offer', uid], queryFn: async () => (await supabase.from('ride_offers').select('*').eq('driver_id', uid).eq('outcome', 'pending').maybeSingle()).data as Offer | null })
  const group = useQuery({ queryKey: ['group', uid], queryFn: async () => (await supabase.from('trip_groups').select('id, status, stops, is_pool').eq('driver_id', uid).in('status', ['accepted', 'arriving', 'ongoing']).maybeSingle()).data as Group | null })
  const history = useQuery({ queryKey: ['dhistory', uid], queryFn: async () => ((await supabase.from('rides').select('*').eq('driver_id', uid).eq('status', 'completed').order('completed_at', { ascending: false }).limit(20)).data ?? []) as Ride[] })
  const tripFare = useQuery({
    queryKey: ['trip-fare', uid, group.data?.id], enabled: !!group.data,
    queryFn: async () => ((await supabase.from('rides').select('fare').eq('driver_id', uid).in('status', ['accepted', 'arriving', 'ongoing'])).data ?? [])
      .reduce((sum, r) => sum + Number((r as { fare: { total: number } }).fare.total), 0),
  })
  const tripRide = useQuery({ queryKey: ['trip-ride', uid, group.data?.id], enabled: !!group.data,
    queryFn: async () => (await supabase.from('rides').select('id, rider_id, est_distance_km, est_trip_min').eq('driver_id', uid)
      .in('status', ['accepted', 'arriving', 'ongoing']).order('requested_at').limit(1).maybeSingle()).data as
      { id: string; rider_id: string; est_distance_km: number; est_trip_min: number } | null })
  const riderName = useQuery({ queryKey: ['rider-name', tripRide.data?.rider_id], enabled: !!tripRide.data,
    queryFn: async () => (await supabase.from('profiles').select('display_name').eq('id', tripRide.data!.rider_id).maybeSingle()).data?.display_name as string | undefined })
  const maxTries = useQuery({ queryKey: ['max-attempts'], staleTime: 60_000, queryFn: async () => (await supabase.from('settings').select('max_attempts').single()).data?.max_attempts as number | undefined })
  const zones = useQuery({ queryKey: ['zone-view', uid], queryFn: () => rpc<ZoneView>('captain_zone_view') })
  const safety = useQuery({ queryKey: ['my-safety', uid], queryFn: () => rpc<SafetySummary>('captain_safety_summary', { p_driver: uid }) })

  const onErr = (e: Error) => { toast.error(friendly(e.message)); qc.invalidateQueries() }
  const toggle = useMutation({ mutationFn: (v: boolean) => rpc('set_online', { p_online: v }), onSuccess: () => qc.invalidateQueries(), onError: onErr })

  // ---- location: requested only when the captain chooses to go online; stops when offline or on sign-out ----
  const geo = useCurrentPosition()
  const [locMode, setLocMode] = useState<'gps' | 'manual' | null>(null)
  const [locError, setLocError] = useState<string | null>(null)
  const sendLoc = (lat: number, lng: number, accuracy: number | null, source: 'gps' | 'manual') =>
    rpc('update_location', { p_lat: lat, p_lng: lng, p_accuracy_m: accuracy, p_source: source })
      .then(() => { setLocError(null); qc.invalidateQueries({ queryKey: ['me', uid] }); qc.invalidateQueries({ queryKey: ['zone-view', uid] }) })
      .catch((e: Error) => setLocError(friendly(e.message)))
  const online = !!me.data?.online
  const watch = useWatchPosition(online && locMode === 'gps', (f) => { void sendLoc(f.lat, f.lng, f.accuracy, 'gps') })
  const watchLast = useRef<Fix | null>(null)
  watchLast.current = watch.last
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
      if (!f) return
      if (!inDemoArea(f.lat, f.lng)) { setLocError('You are outside the Belagavi demo area. Go online with a manual position instead.'); return }
      await sendLoc(f.lat, f.lng, f.accuracy, 'gps')
    } else if (me.data) {
      await sendLoc(me.data.lat, me.data.lng, null, 'manual')
    }
    setLocMode(mode)
    toggle.mutate(true)
  }
  const respond = useMutation({
    mutationFn: (a: 'accept' | 'decline' | 'ignore') => a === 'ignore' ? rpc('ignore_offer', { p_offer: offer.data!.id })
      : rpc('respond_offer', { p_offer: offer.data!.id, p_accept: a === 'accept' }),
    onSuccess: (_d, a) => { if (a !== 'accept') toast(a === 'ignore' ? 'Ignored. The request went straight to the next captain.' : 'Declined. The request went to the next captain.'); qc.invalidateQueries() },
    onError: onErr,
  })
  const advance = useMutation({ mutationFn: (to: RideStatus) => rpc('advance_trip', { p_group: group.data!.id, p_to: to }), onSuccess: () => qc.invalidateQueries(), onError: onErr })
  const cancelTrip = useMutation({ mutationFn: () => rpc('driver_cancel', { p_group: group.data!.id }), onSuccess: () => { toast('Trip released. Your rider is being reassigned.'); qc.invalidateQueries() }, onError: onErr })

  const stops = group.data?.stops ?? offer.data?.summary.stops ?? []
  const pins: Pin[] = stops.map((s, i) => ({ lat: s.lat, lng: s.lng, kind: stops.length > 2 ? 'stop' : s.type, label: `${s.type === 'pickup' ? 'Pickup' : 'Drop'}: ${s.label}`, text: stops.length > 2 ? String(i + 1) : undefined }))
  const meDrv = me.data ? [{ id: uid, lat: me.data.lat, lng: me.data.lng, label: 'You', category: me.data.vehicle_category, highlight: true }] : []
  const mv = zones.data?.open_move
  const target = mv ? zones.data?.zones.find((z) => z.zone_id === mv.to_zone) : undefined
  const pts = [...meDrv.map((d) => [d.lat, d.lng] as [number, number]), ...pins.map((p) => [p.lat, p.lng] as [number, number])]
  const acc = me.data ? Math.round(((me.data.offers_accepted + 4) / (me.data.offers_received + 5)) * 100) : 0
  const earned = (history.data ?? []).reduce((s, r) => s + Number(r.fare.total), 0)
  // SIMULATED estimate: 80% payout, vehicle cost for trip + pickup km (pickup km estimated from the stored pickup ETA)
  const econ = (history.data ?? []).map((r) => rideEconomics({ category: r.category, fareTotal: Number(r.fare.total), gst: Number(r.fare.gst ?? 0),
    tripKm: Number(r.est_distance_km), pickupKm: Number(r.est_pickup_min ?? 0) * 25 / 60, tripMin: Number(r.est_trip_min), pickupMin: Number(r.est_pickup_min ?? 0) }))
  const sumE = (k: 'driverGross' | 'vehicleCost' | 'driverNet') => econ.reduce((s, e) => s + e[k], 0)
  const traffic = useTraffic()
  const tl = useTrafficLevel(zones.data?.physical_zone)
  // "Ride completed" confirmation for the captain: the trip leaves the active list once it is completed
  const prevTrip = useRef<string | null>(null)
  const [justDone, setJustDone] = useState(false)
  useEffect(() => {
    const st = group.data?.status ?? null
    if (!st && prevTrip.current === 'ongoing') { setJustDone(true); const t = setTimeout(() => setJustDone(false), 8000); prevTrip.current = null; return () => clearTimeout(t) }
    prevTrip.current = st
  }, [group.data?.status])
  const o = offer.data, g = group.data, next = g ? NEXT[g.status] : undefined
  const idleMin = me.data?.online && me.data.idle_since ? Math.max(0, Math.round((Date.now() - new Date(me.data.idle_since).getTime()) / 60000)) : null
  const sl = safetyLabel(safety.data)

  return (
    <>
      <MapFirstLayout
        mapLabel={online ? <><span className="size-2 rounded-full bg-emerald-500 motion-safe:animate-pulse" />{locMode === 'gps' ? 'Live GPS' : 'Manual position'}</> : <>Offline · location not shared</>}
        map={<MapCanvas drivers={meDrv} pins={pins} route={pins.length >= 2 ? pins.map((p) => [p.lat, p.lng]) : undefined} fit={pts.length ? pts : undefined} fitKey={g ? `${g.id}:${g.status}` : online ? 'online' : 'offline'}
          legend={<TrafficLegend />}
          zones={target ? [...traffic, { id: target.zone_id, name: `Heading to ${target.name}`, lat: zoneCentre(target.zone_id).lat, lng: zoneCentre(target.zone_id).lng, color: ZONE_STATE_COLOR[target.state], strong: true }] : traffic}
          onPick={online && locMode === 'manual' && !g ? (lat, lng) => { if (inDemoArea(lat, lng)) void sendLoc(lat, lng, null, 'manual') } : undefined} />}>
        {me.isLoading ? (
          <Panel><div className="space-y-3" aria-busy="true"><Skeleton className="h-12 w-48" /><Skeleton className="h-20 w-full rounded-2xl" /><Skeleton className="h-14 w-full rounded-2xl" /></div></Panel>
        ) : me.error || !me.data ? (
          <Panel><LoadError what="your captain profile" error={me.error} retry={() => me.refetch()} /></Panel>
        ) : <>
          <Panel aria-label="Captain status">
            <div className="flex items-center justify-between gap-3 border-b pb-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-12 shrink-0 place-items-center rounded-xl border border-teal-200 bg-teal-50 text-teal-800"><Car className="size-6" aria-hidden /></span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><h1 className="truncate text-base font-bold sm:text-lg">{profile?.display_name ?? 'Captain'}</h1><SimBadge className="max-sm:hidden" /></div>
                  <p className="truncate font-mono text-xs text-slate-500">{me.data.plate} • <span className="font-semibold text-teal-800 uppercase">{CAT_LABEL[me.data.vehicle_category]}</span></p>
                </div>
              </div>
              {!o && !g && (
                <button type="button" disabled={toggle.isPending || geo.status === 'locating'} onClick={() => (online ? toggle.mutate(false) : goOnline('gps'))}
                  aria-pressed={online} aria-label={online ? 'You are online. Go offline' : 'You are offline. Go online'}
                  className={cn('flex h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3.5 text-xs font-bold tracking-wide shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
                    online ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100' : 'border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200')}>
                  {toggle.isPending || geo.status === 'locating' ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Power className="size-3.5" aria-hidden />}
                  {online ? 'ONLINE' : 'OFFLINE'}
                </button>
              )}
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-2xl border bg-surface p-3">
                <div className="flex items-center gap-1 text-[10px] font-bold text-slate-500 uppercase"><MapPin className="size-3 text-teal-700" aria-hidden />Operational zone</div>
                <div className="mt-1 truncate text-sm font-semibold">{zones.data?.op_zone_name ?? '…'}</div>
                {zones.data && zones.data.physical_zone !== zones.data.op_zone && <div className="truncate text-[11px] text-slate-500">Now in {zones.data.physical_zone_name}</div>}
              </div>
              <div className="rounded-2xl border bg-surface p-3">
                <div className="flex items-center gap-1 text-[10px] font-bold text-slate-500 uppercase"><Navigation className="size-3 text-indigo-600" aria-hidden />Traffic</div>
                <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
                  {tl && <span className="size-2 rounded-full" style={{ background: TRAFFIC_COLOR[tl.level] }} aria-hidden />}{tl?.label ?? '…'}
                </div>
                {tl && <div className="text-[11px] text-slate-500 num">~{tl.kmh} km/h (est.)</div>}
              </div>
              <div className="rounded-2xl border bg-surface p-3">
                <div className="flex items-center gap-1 text-[10px] font-bold text-slate-500 uppercase"><Clock className="size-3 text-amber-600" aria-hidden />Idle time</div>
                <div className="mt-1 font-mono text-sm font-semibold">{online ? (idleMin == null ? 'On a trip' : `${idleMin} min`) : 'Offline'}</div>
              </div>
            </div>

            <dl className="mt-3 grid grid-cols-4 gap-2 rounded-2xl border bg-surface p-3 text-center">
              <div><dt className="text-[10px] text-slate-500">Trips today</dt><dd className="mt-0.5 text-sm font-bold num">{me.data.trips_today}</dd></div>
              <div><dt className="text-[10px] text-slate-500">Acceptance</dt><dd className="mt-0.5 text-sm font-bold text-teal-800 num">{acc}%</dd></div>
              <div title="Fewer trips today scores higher on the workload part of matching, so work is shared fairly">
                <dt className="text-[10px] text-slate-500">Fair share</dt>
                <dd className={cn('mt-0.5 text-sm font-bold', me.data.trips_today <= 2 ? 'text-emerald-700' : me.data.trips_today <= 5 ? 'text-slate-800' : 'text-amber-700')}>
                  {me.data.trips_today <= 2 ? 'Priority' : me.data.trips_today <= 5 ? 'Standard' : 'Busy day'}
                </dd>
              </div>
              <div><dt className="text-[10px] text-slate-500">Safety</dt><dd className="mt-0.5 text-sm font-bold num" title={sl.detail}>{safety.data?.published ? `${safety.data.overall?.toFixed(1)}/5` : '—'}</dd></div>
            </dl>
            <p className="mt-1.5 text-[11px] text-slate-500">Safety: {sl.detail}</p>

            {!o && !g && (
              <div className="mt-3">
                <LocationStatus online={online} mode={locMode} geoStatus={online ? watch.status : geo.status} fix={watch.last ?? geo.fix}
                  updatedAt={me.data.location_updated_at} error={locError} onManual={() => goOnline('manual')} onRetryGps={() => (online ? setLocMode('gps') : goOnline('gps'))} />
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setEarningsOpen(true)}><Wallet className="size-3.5" aria-hidden />Earnings and trips</Button>
            </div>
          </Panel>

          {g && (
            <Panel aria-label="Current trip">
              <div className="flex items-start justify-between gap-3 border-b pb-4">
                <div>
                  <div className="flex items-center gap-2"><h2 className="text-base font-bold sm:text-lg">{next?.title ?? 'Current trip'}</h2><SimBadge /></div>
                  <p className="mt-0.5 text-xs text-slate-500">Passenger: <b className="text-slate-800">{riderName.data ?? '…'}</b>{g.is_pool && ' + 1 co-rider'}</p>
                  <div className="mt-1"><StatusChip status={g.status} short /></div>
                </div>
                {tripFare.data != null && <div className="text-right"><div className="text-[11px] text-slate-500">Fare (est.)</div><div className="font-mono text-lg font-black text-teal-800 num">{inr(tripFare.data)}</div></div>}
              </div>
              <div className="mt-4"><StopList stops={g.stops} numbered={g.is_pool} /></div>
              {tripRide.data && (
                <p className="mt-3 flex justify-between rounded-xl border bg-surface px-3 py-2 text-xs text-slate-600">
                  <span>Distance <b className="text-slate-900 num">{Number(tripRide.data.est_distance_km).toFixed(1)} km</b></span>
                  <span>Trip time <b className="text-slate-900 num">{Math.round(tripRide.data.est_trip_min)} min</b></span>
                </p>
              )}
              {tripRide.data && <div className="mt-3"><ContactButton rideId={tripRide.data.id} me={uid} other={riderName.data ?? 'your rider'} as="captain" live /></div>}
              <ActionBar>
                {next && (
                  <Button size="lg" className={cn('w-full', g.status === 'arriving' && 'bg-emerald-700 hover:bg-emerald-800')} disabled={advance.isPending} onClick={() => advance.mutate(next.to)}>
                    {advance.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : g.status === 'ongoing' ? <CheckCircle2 className="size-4" aria-hidden /> : <Navigation className="size-4" aria-hidden />}{next.label}
                  </Button>
                )}
                {['accepted', 'arriving'].includes(g.status) && (
                  <Button variant="ghost" className="mt-2 w-full text-rose-700 hover:bg-rose-50 hover:text-rose-800" disabled={cancelTrip.isPending} onClick={() => cancelTrip.mutate()}>
                    Cancel trip (your rider is reassigned automatically)
                  </Button>
                )}
              </ActionBar>
            </Panel>
          )}

          {justDone && !g && (
            <p role="status" className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
              <CheckCircle2 className="size-5 shrink-0 text-emerald-600" aria-hidden />Ride completed. You are available for new bookings.
            </p>
          )}
          {!g && <ZonePanel view={zones.data} loading={zones.isLoading} error={zones.error} refetch={() => zones.refetch()} online={online} />}
          {!me.data.is_simulated && <WomenRidersOptIn uid={uid} />}
        </>}
      </MapFirstLayout>

      {o && <OfferCard offer={o} maxTries={maxTries.data ?? 5} busy={respond.isPending} onRespond={(a) => respond.mutate(a)} />}

      <Sheet open={earningsOpen} onOpenChange={setEarningsOpen}>
        <SheetContent side={phone ? 'bottom' : 'right'} className={cn('bg-white', phone && 'max-h-[85dvh] rounded-t-3xl pb-[env(safe-area-inset-bottom)]')}>
          <SheetHeader><SheetTitle>Earnings</SheetTitle><SheetDescription>Last 20 completed trips. Simulated estimates: 80% payout share, vehicle costs from dated fuel prices and assumptions.</SheetDescription></SheetHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            <dl className="grid grid-cols-2 gap-2">
              <div className="rounded-2xl border bg-surface p-3"><dt className="text-xs text-slate-500">Passenger fares</dt><dd className="text-xl font-bold num">{inr(earned)}</dd></div>
              <div className="rounded-2xl border bg-surface p-3"><dt className="text-xs text-slate-500">Your payout (80%, ex-GST)</dt><dd className="text-xl font-bold num">{inr(sumE('driverGross'))}</dd></div>
              <div className="rounded-2xl border bg-surface p-3"><dt className="text-xs text-slate-500">Est. fuel and vehicle cost</dt><dd className="text-xl font-bold num">−{inr(sumE('vehicleCost'))}</dd></div>
              <div className="rounded-2xl border border-teal-200 bg-teal-50 p-3"><dt className="text-xs text-teal-800">Est. net earnings</dt><dd className="text-xl font-bold text-teal-900 num">{inr(sumE('driverNet'))}</dd></div>
            </dl>
            <p className="text-[11px] leading-snug text-slate-500">Vehicle cost covers paid and empty (pickup) kilometres: energy at Belagavi prices of 13 Nov 2026, maintenance and depreciation assumptions. Trips today: {me.data?.trips_today ?? 0}.</p>
            {history.isLoading ? <Skeleton className="h-24 w-full" /> : !history.data?.length ? <Empty>No completed trips yet.</Empty> : (
              <ul className="divide-y">
                {history.data.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 py-3 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{r.drop_label}</span>
                      <span className="block truncate text-xs text-slate-500">from {r.pickup_label}{r.completed_at && ` · ${new Date(r.completed_at).toLocaleTimeString([], { timeStyle: 'short' })}`}</span>
                    </span>
                    <span className="font-bold num">{inr(r.fare.total)}</span>
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

// zone centres for the map overlay (same as the seeded zones table)
const ZC: Record<number, { lat: number; lng: number }> = {
  1: { lat: 15.86112, lng: 74.51492 }, 2: { lat: 15.83686, lng: 74.50193 }, 3: { lat: 15.8879, lng: 74.51992 }, 4: { lat: 15.83359, lng: 74.52421 },
  5: { lat: 15.81746, lng: 74.49263 }, 6: { lat: 15.7773, lng: 74.46486 }, 7: { lat: 15.88564, lng: 74.54633 }, 8: { lat: 15.86308, lng: 74.61119 },
}
const zoneCentre = (id: number) => ZC[id] ?? ZC[1]

function OfferCard({ offer: o, maxTries, busy, onRespond }: { offer: Offer; maxTries: number; busy: boolean; onRespond: (a: 'accept' | 'decline' | 'ignore') => void }) {
  const { s, pct } = useSecondsLeft(o.offered_at, o.expires_at)
  return (
    <div className="fixed inset-x-0 bottom-0 z-[1200] p-3 sm:right-6 sm:bottom-6 sm:left-auto sm:w-[420px] sm:p-0 motion-safe:animate-in motion-safe:slide-in-from-bottom">
      <div role="alertdialog" aria-labelledby="offer-title" aria-describedby="offer-summary"
        className="relative overflow-hidden rounded-3xl border-2 border-teal-600 bg-white p-5 pb-[max(env(safe-area-inset-bottom),20px)] shadow-2xl ring-4 ring-teal-600/15">
        <div className="absolute inset-x-0 top-0 h-1.5 bg-slate-200" aria-hidden>
          <div className={cn('h-full', s <= 5 ? 'bg-rose-600' : 'bg-teal-600')} style={{ width: `${pct}%`, transition: 'width 250ms linear' }} />
        </div>
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <div className="flex items-center gap-2"><span id="offer-title" className="text-xs font-bold tracking-wider text-teal-800 uppercase">New {o.summary.is_pool ? 'shared ' : ''}ride request</span><SimBadge /></div>
            <div className="mt-0.5 font-mono text-xs text-slate-500">Attempt {o.attempt_no} of {maxTries}</div>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border bg-slate-100 px-2.5 py-1" aria-live="off">
            <Clock className={cn('size-3.5', s <= 5 ? 'text-rose-600 motion-safe:animate-pulse' : 'text-teal-700')} aria-hidden />
            <span className={cn('font-mono text-sm font-bold num', s <= 5 ? 'text-rose-600' : 'text-slate-800')}>{s > 0 ? `${s}s` : '0s'}</span>
          </div>
        </div>
        <div id="offer-summary" className="my-4 flex items-center justify-between rounded-2xl border bg-surface p-3.5">
          <div><div className="text-[11px] text-slate-500">Estimated fare</div><div className="font-mono text-2xl font-black num">{inr(o.summary.fare)}</div></div>
          <div className="text-right"><div className="text-[11px] text-slate-500">To pickup</div><div className="font-mono text-base font-bold text-slate-700 num">{Math.ceil(o.summary.pickup_min)} min · {Number(o.summary.pickup_km).toFixed(1)} km</div>
            <div className="mt-1 text-[11px] text-slate-500">Trip <b className="font-mono text-slate-700 num">{tripKm(o.summary.stops).toFixed(1)} km</b></div></div>
        </div>
        {o.summary.women_driver_pref && <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-teal-800"><ShieldCheck className="size-4" aria-hidden />The rider asked for a woman captain</p>}
        {o.summary.is_pool && <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-sky-800"><Users className="size-4" aria-hidden />Shared ride: two riders, fares split. Accept or decline it like any ride.</p>}
        <StopList stops={o.summary.stops} numbered={o.summary.is_pool} />
        {s <= 0 && <p className="mt-2 text-xs text-slate-500">Time is up. The request is passing to the next captain.</p>}
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Button variant="ghost" size="lg" disabled={busy} onClick={() => onRespond('ignore')} title="Skip without declining: goes to the next captain now">Ignore</Button>
          <Button variant="outline" size="lg" disabled={busy} onClick={() => onRespond('decline')}><X className="size-4 text-slate-500" aria-hidden />Decline</Button>
          <Button size="lg" disabled={busy} onClick={() => onRespond('accept')}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}Accept</Button>
        </div>
      </div>
    </div>
  )
}

/** Zone switching: current zones, the system's suggestion (with its reason), and a captain-chosen move. */
function ZonePanel({ view, loading, error, refetch, online }: { view?: ZoneView; loading: boolean; error: unknown; refetch: () => void; online: boolean }) {
  const qc = useQueryClient()
  const [showAll, setShowAll] = useState(false)
  const done = () => qc.invalidateQueries({ queryKey: ['zone-view'] })
  const respond = useMutation({ mutationFn: ({ id, accept }: { id: string; accept: boolean }) => rpc('captain_respond_move', { p_move: id, p_accept: accept }),
    onSuccess: (_d, v) => { toast(v.accept ? 'Heading there. The zone becomes yours when you arrive.' : 'Suggestion declined.'); done() }, onError: (e) => toast.error(friendly(e.message)) })
  const request = useMutation({ mutationFn: (zone: number) => rpc('captain_request_zone', { p_zone: zone }),
    onSuccess: () => { toast('Move started. It becomes operational once your location shows you there.'); done() }, onError: (e) => toast.error(friendly(e.message)) })
  const cancel = useMutation({ mutationFn: () => rpc('captain_cancel_move'), onSuccess: () => { toast('Move cancelled.'); done() }, onError: (e) => toast.error(friendly(e.message)) })
  const mv = view?.open_move
  const others = (view?.zones ?? []).filter((z) => !z.current)
  const list = showAll ? others : others.filter((z) => z.state === 'undersupplied').slice(0, 3)
  const blocked = view?.blocked_reason
  return (
    <Panel aria-labelledby="zones-title">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2"><Compass className="size-4 text-amber-600" aria-hidden /><h2 id="zones-title" className="text-base font-bold">Where riders need you</h2><SimBadge /></div>
          <p className="mt-0.5 text-xs text-slate-500">Expected requests in the next 30 minutes vs captains there. Recommendations are optional.</p>
        </div>
      </div>
      {loading ? <Skeleton className="h-28 w-full rounded-2xl" /> : error ? <LoadError what="zone information" error={error} retry={refetch} /> : !view ? null : <>
        {mv && (
          <div className={cn('mb-3 rounded-2xl border p-3.5 text-sm', mv.status === 'recommended' ? 'border-amber-200 bg-amber-50' : 'border-teal-200 bg-teal-50')}>
            <div className="flex items-center gap-1.5 font-bold">
              {mv.status === 'recommended' ? <><TrendingUp className="size-4 text-amber-700" aria-hidden />Suggested: move to {mv.to_name}</> : <><ArrowRight className="size-4 text-teal-700" aria-hidden />En route to {mv.to_name}</>}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-700">{mv.reason.text}</p>
            <p className="mt-1 text-xs text-slate-600 num">About {Number(mv.km).toFixed(1)} km · {Math.ceil(mv.eta_min)} min drive{mv.status === 'accepted' && ' · becomes your operational zone when your location shows you there'}</p>
            <div className="mt-3 flex gap-2">
              {mv.status === 'recommended' ? <>
                <Button size="sm" disabled={respond.isPending || !!blocked && blocked !== 'cooldown'} onClick={() => respond.mutate({ id: mv.id, accept: true })}>Head there</Button>
                <Button size="sm" variant="outline" disabled={respond.isPending} onClick={() => respond.mutate({ id: mv.id, accept: false })}>Not now</Button>
              </> : <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel move</Button>}
            </div>
          </div>
        )}
        {!online && <Empty className="mb-3">Go online to get zone recommendations and switch zones.</Empty>}
        {online && blocked && !mv && <p className="mb-3 rounded-xl border bg-surface px-3 py-2 text-xs text-slate-600">{BLOCKED[blocked]}{blocked === 'cooldown' && ` Try again in about ${view.cooldown_min_left} min.`}</p>}
        {list.length === 0 ? (
          <Empty>{showAll ? 'No other zones.' : 'No zone is short of captains right now. Staying put is the best move.'}</Empty>
        ) : (
          <ul className="space-y-2">
            {list.map((z) => (
              <li key={z.zone_id} className="flex items-center gap-3 rounded-2xl border bg-surface p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">{z.name}</span>
                    <Tag tone={STATE_TONE[z.state]}>{STATE_TEXT[z.state]}</Tag>
                    {z.peak && <Tag tone="warning">Peak</Tag>}
                    {z.rising && <Tag tone="warning"><TrendingUp className="size-3" aria-hidden />Rising</Tag>}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 num">~{Math.round(z.demand_30)} request{Math.round(z.demand_30) === 1 ? '' : 's'} · {z.expected_supply} captain{z.expected_supply === 1 ? '' : 's'} · {Number(z.km).toFixed(1)} km, {Math.ceil(z.eta_min)} min</p>
                </div>
                <Button size="sm" variant="outline" className="shrink-0" disabled={!!blocked || !!mv && mv.status === 'accepted' || z.state === 'oversupplied' || request.isPending}
                  onClick={() => request.mutate(z.zone_id)} aria-label={`Move to ${z.name}`}>Move here</Button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show only zones that need captains' : 'Show all zones'}</Button>
      </>}
    </Panel>
  )
}

/** Self-managed, informed opt-in. Restricted: only this captain, dispatch and admins can read it. */
function WomenRidersOptIn({ uid }: { uid: string }) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const pref = useQuery({ queryKey: ['my-pref', uid], queryFn: async () => (await supabase.from('captain_preferences').select('women_riders_optin, consented_at').eq('user_id', uid).maybeSingle()).data as { women_riders_optin: boolean; consented_at: string | null } | null })
  const set = useMutation({
    mutationFn: (v: boolean) => rpc<{ released_offers: number }>('set_women_riders_optin', { p_optin: v }),
    onSuccess: (r, v) => { setConfirming(false); toast(v ? 'Opted in. You can withdraw at any time.' : r.released_offers ? 'Withdrawn. Your pending request was passed to another captain.' : 'Withdrawn.'); qc.invalidateQueries() },
    onError: (e) => toast.error(friendly(e.message)),
  })
  const on = !!pref.data?.women_riders_optin
  return (
    <Panel aria-labelledby="pref-title">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-teal-700" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="pref-title" className="text-base font-bold">Rides for riders who prefer a woman driver</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            Riders can ask for a woman driver. If you are a woman captain, you can choose to receive those requests too. Your choice is private: riders and other captains never see it,
            and it does not change how you are ranked for any other ride.
          </p>
          {pref.isLoading ? <Skeleton className="mt-3 h-10 w-40" /> : on ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Tag tone="success"><Check className="size-3.5" aria-hidden />Opted in</Tag>
              <Button size="sm" variant="outline" disabled={set.isPending} onClick={() => set.mutate(false)}>Withdraw</Button>
            </div>
          ) : confirming ? (
            <div className="mt-3 space-y-2 rounded-2xl border bg-surface p-3 text-xs">
              <p>I confirm I am a woman captain and want to receive requests from riders who prefer a woman driver. This is self-declared; it is not an identity verification.</p>
              <div className="flex gap-2">
                <Button size="sm" disabled={set.isPending} onClick={() => set.mutate(true)}>{set.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}Confirm and opt in</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <label className="mt-3 flex items-center gap-3 text-sm font-semibold">
              <Switch checked={false} onCheckedChange={() => setConfirming(true)} aria-label="Receive requests from riders who prefer a woman driver" />Receive these requests
            </label>
          )}
        </div>
      </div>
    </Panel>
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
    <div className="space-y-2 rounded-2xl border bg-surface p-3 text-sm" aria-live="polite">
      <Eyebrow>Location</Eyebrow>
      {online && mode === 'gps' && !failed && (
        <p className="flex items-center gap-2"><LocateFixed className="size-4 text-teal-700" aria-hidden />
          {fix ? <>GPS · ±{fix.accuracy} m{age != null && ` · sent ${age}s ago`}</> : 'Waiting for a GPS fix…'}</p>
      )}
      {online && mode === 'gps' && fix && fix.accuracy > GOOD_ACCURACY_M && (
        <p className="text-xs text-amber-800">Accuracy is above {GOOD_ACCURACY_M} m, so you won't be matched until it improves. Move to open sky, or use a manual position.</p>
      )}
      {online && mode === 'manual' && (
        <p className="flex items-center gap-2"><MapPinned className="size-4 text-slate-500" aria-hidden />Manual position · tap the map to move it{age != null && ` · refreshed ${age}s ago`}</p>
      )}
      {failed && <p className="text-xs text-slate-600">{GEO_MESSAGE[geoStatus]}</p>}
      {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
      {(failed || error || (online && mode === 'manual')) && (
        <div className="flex flex-wrap gap-2">
          {!(online && mode === 'manual') && <Button size="sm" variant="outline" onClick={onManual}><MapPinned className="size-4" aria-hidden />{online ? 'Use manual position' : 'Go online with a manual position'}</Button>}
          {geoStatus !== 'unsupported' && geoStatus !== 'insecure' && <Button size="sm" variant="ghost" onClick={onRetryGps}><LocateFixed className="size-4" aria-hidden />Use GPS</Button>}
        </div>
      )}
      {!online && !failed && !error && <p className="text-xs text-slate-500">Going online shares your location so nearby requests reach you, and shows it to your rider during a trip. It stops the moment you go offline.</p>}
    </div>
  )
}

/** Trip length over the stops, straight-line x the road factor (same model as fares). */
const tripKm = (stops: Stop[]) => stops.slice(1).reduce((sum, st, i) => sum + km(stops[i], st), 0) * ROAD_FACTOR
