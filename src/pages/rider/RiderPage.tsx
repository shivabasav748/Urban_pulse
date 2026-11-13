import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowUpDown, Check, ChevronRight, Clock, History, Loader2, LocateFixed, MapPin, Navigation, RefreshCw, Search, ShieldAlert,
  ShieldCheck, TrendingUp, Users, X, XCircle } from 'lucide-react'
import { MapCanvas, type MapDriver, type MapPin as Pin } from '@/components/map/MapCanvas'
import { ActionBar, MapFirstLayout } from '@/components/layout/AppShell'
import { CAT_ICON, CAT_LABEL, Empty, Eyebrow, FareBreakdown, LoadError, Panel, SimBadge, StatusChip, StatusStepper, Tag, friendly, statusText } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/lib/auth'
import { useLive, usePhone, useSweep } from '@/lib/hooks'
import { GEO_MESSAGE, GOOD_ACCURACY_M, STALE_MS, useCurrentPosition } from '@/lib/geolocation'
import { PLACES, inDemoArea, pointPlace, searchPlaces, type Place } from '@/lib/places'
import { rpc, supabase, type Ride } from '@/lib/supabase'
import { inr } from '@/lib/geo'
import { safetyLabel, type SafetySummary } from '@/lib/zones'
import { cn } from '@/lib/utils'

type Cat = 'bike' | 'auto' | 'cab'
type Marker = { category: Cat; lat: number; lng: number; n: number }
type Estimate = {
  distance_km: number; surge: number; radius_m: number; markers: Marker[]
  zone?: { name: string; forecast: number; supply: number; raw: number; smoothed: number }
  categories: { category: Cat; trip_min: number; fare: Ride['fare']; drivers: number; pickup_eta_min: number | null }[]
}
type Availability = { radius_m: number; categories: { category: Cat; count: number; pickup_eta_min: number | null }[]; markers: Marker[] }
type Captain = { user_id: string; lat: number; lng: number; vehicle_category: Cat; vehicle_label: string; plate: string; location_updated_at: string | null; location_source: string }
type RideX = Ride & { women_driver_pref: boolean }
type Ev = { id: number; type: string; at: string; payload: Record<string, unknown> }
const ACTIVE = ['requested', 'offered', 'accepted', 'arriving', 'ongoing']
const RADII = [2000, 3000, 5000] as const
const km = (m: number) => `${m / 1000} km`
const approxMarkers = (ms: Marker[] = []): MapDriver[] =>
  ms.map((m, i) => ({ id: `a${i}`, lat: m.lat, lng: m.lng, label: 'Captains nearby', category: m.category, approx: true, n: m.n }))
const QUICK = [['railway-station', 'Railway Station'], ['tilakwadi', 'Tilakwadi'], ['airport', 'Airport'], ['vtu', 'VTU'], ['udyambag', 'Udyambag']] as const
const placeById = (id: string) => PLACES.find((p) => p.id === id)!
const FAIL = ['offer_rejected', 'offer_no_response', 'offer_cancelled', 'driver_cancelled', 'arrival_delayed', 'captain_unreachable']
const PREF_KEY = 'up.preferWoman'
const readPref = () => { try { return sessionStorage.getItem(PREF_KEY) === '1' } catch { return false } }

/** What the passenger needs to know, from the ride's own event log. Never internals or errors. */
function riderMessage(ride: RideX, events: Ev[], waiting: boolean) {
  const last = events[0]
  if (ride.status === 'no_driver_found') return { title: 'No suitable captains available right now', tone: 'danger' as const }
  if (waiting) return { title: ride.women_driver_pref ? 'Still looking for a woman captain' : 'Still looking for a captain', tone: 'info' as const }
  if (ride.status === 'offered') return { title: ride.attempt_no > 1 ? 'Another captain notified' : 'Captain notified', tone: 'info' as const }
  if (ride.status === 'requested') return { title: last && FAIL.includes(last.type) ? 'Captain unavailable · finding another captain' : 'Finding a captain', tone: 'info' as const }
  if (ride.status === 'accepted' && ride.attempt_no > 1) return { title: 'New captain assigned', tone: 'brand' as const }
  return { title: statusText(ride.status), tone: 'brand' as const }
}

/** Search over demo landmarks + the rider's own recent places. */
function PlaceSearch({ label, recents, onPick, onClose, extra }: { label: string; recents: Place[]; onPick: (p: Place) => void; onClose?: () => void; extra?: React.ReactNode }) {
  const [q, setQ] = useState('')
  const hits = searchPlaces(q)
  const recentHits = recents.filter((r) => !q || `${r.name} ${r.area}`.toLowerCase().includes(q.trim().toLowerCase()))
  const row = (p: Place, icon: React.ReactNode) => (
    <li key={p.id}>
      <button type="button" onClick={() => onPick(p)}
        className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-left outline-none hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-ring">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-500" aria-hidden>{icon}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{p.name}</span><span className="block truncate text-xs text-slate-500">{p.area}</span></span>
      </button>
    </li>
  )
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="flex h-12 flex-1 items-center gap-2 rounded-2xl border bg-white px-3 focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/20">
          <Search className="size-4 shrink-0 text-slate-400" aria-hidden />
          <span className="sr-only">{label}</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder={label} enterKeyHint="search"
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-slate-400" />
        </label>
        {onClose && <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close search"><X className="size-4" aria-hidden /></Button>}
      </div>
      {extra}
      <div className="max-h-[38dvh] overflow-y-auto overscroll-contain">
        {recentHits.length > 0 && <>
          <Eyebrow className="px-2 pt-1 pb-0.5">Recent</Eyebrow>
          <ul>{recentHits.slice(0, 4).map((p) => row(p, <Clock className="size-4" />))}</ul>
        </>}
        <Eyebrow className="px-2 pt-2 pb-0.5">Belagavi landmarks</Eyebrow>
        {hits.length ? <ul>{hits.map((p) => row(p, <MapPin className="size-4" />))}</ul>
          : <p className="px-2 py-3 text-sm text-slate-500">No landmark matches “{q}”. Try another name, or tap the map to drop a pin.</p>}
      </div>
    </div>
  )
}

export default function RiderPage() {
  const { session } = useAuth()
  const uid = session!.user.id
  const qc = useQueryClient()
  const phone = usePhone()
  const geo = useCurrentPosition()
  const [pickup, setPickupRaw] = useState<Place>()
  const [drop, setDrop] = useState<Place>()
  const [field, setField] = useState<'pickup' | 'drop' | null>('pickup')
  const [cat, setCat] = useState<Cat>('bike')
  const [radius, setRadius] = useState<(typeof RADII)[number]>(2000)
  const [preferWoman, setPreferWomanRaw] = useState(readPref)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const setPreferWoman = (v: boolean) => { setPreferWomanRaw(v); try { sessionStorage.setItem(PREF_KEY, v ? '1' : '0') } catch { /* private mode */ } }
  const setPickup = (p?: Place) => { setPickupRaw(p); setRadius(2000) }
  useSweep()
  useLive('rides', [['rides', uid]], `rider_id=eq.${uid}`)

  const rides = useQuery({
    queryKey: ['rides', uid],
    queryFn: async () => {
      const { data, error } = await supabase.from('rides').select('*').eq('rider_id', uid).order('requested_at', { ascending: false }).limit(30)
      if (error) throw error
      return data as RideX[]
    },
  })
  const active = rides.data?.find((r) => ACTIVE.includes(r.status))
  const latest = rides.data?.[0]
  const showTracker = active ?? (latest && Date.now() - new Date(latest.requested_at).getTime() < 30 * 60e3 && !dismissed(latest.id) ? latest : undefined)
  const captainId = showTracker?.driver_id ?? undefined
  const trackingLive = !!showTracker && ['accepted', 'arriving', 'ongoing'].includes(showTracker.status)

  const recents = useMemo(() => {
    const seen = new Set<string>(), out: Place[] = []
    for (const r of rides.data ?? []) for (const p of [
      { id: `r:${r.id}:d`, name: r.drop_label, area: 'Recent destination', lat: r.drop_lat, lng: r.drop_lng },
      { id: `r:${r.id}:p`, name: r.pickup_label, area: 'Recent pickup', lat: r.pickup_lat, lng: r.pickup_lng },
    ]) if (!seen.has(p.name) && !/^(Current|Pinned) location/.test(p.name)) { seen.add(p.name); out.push(p) }
    return out
  }, [rides.data])

  // Before a match: privacy-safe availability only (counts + grid-snapped markers). Never other captains' coordinates.
  const availability = useQuery({
    queryKey: ['availability', pickup?.lat, pickup?.lng, radius],
    enabled: !!pickup && !drop && !showTracker,
    queryFn: () => rpc<Availability>('nearby_availability', { p_lat: pickup!.lat, p_lng: pickup!.lng, p_radius_m: radius }),
  })
  const estimate = useQuery({
    queryKey: ['estimate', pickup?.lat, pickup?.lng, drop?.lat, drop?.lng, radius],
    enabled: !!pickup && !!drop && !showTracker,
    queryFn: () => rpc<Estimate>('estimate_ride', { p_lat: pickup!.lat, p_lng: pickup!.lng, d_lat: drop!.lat, d_lng: drop!.lng, p_radius_m: radius }),
  })
  // The tracked ride's search state (keep-waiting window) and its own event log.
  const tid = showTracker?.id
  const group = useQuery({
    queryKey: ['ride-group', tid], enabled: !!tid,
    queryFn: async () => (await supabase.from('trip_group_members').select('trip_groups(status, wait_until)').eq('ride_id', tid!).maybeSingle()).data as { trip_groups: { status: string; wait_until: string | null } | null } | null,
  })
  const events = useQuery({
    queryKey: ['ride-events', tid], enabled: !!tid,
    queryFn: async () => ((await supabase.from('ride_events').select('id, type, at, payload').eq('ride_id', tid!).order('id', { ascending: false }).limit(12)).data ?? []) as Ev[],
  })
  useLive('ride_events', [['ride-events', tid]], tid ? `ride_id=eq.${tid}` : 'ride_id=eq.00000000-0000-0000-0000-000000000000')
  // After a match: the assigned captain's precise row. The database only returns it to this rider, during the trip.
  const captain = useQuery({
    queryKey: ['captain', captainId], enabled: !!captainId && trackingLive,
    queryFn: async () => (await supabase.from('driver_profiles').select('user_id, lat, lng, vehicle_category, vehicle_label, plate, location_updated_at, location_source').eq('user_id', captainId!).maybeSingle()).data as Captain | null,
  })
  const captainName = useQuery({
    queryKey: ['captain-name', captainId], enabled: !!captainId,
    queryFn: async () => (await supabase.from('profiles').select('display_name').eq('id', captainId!).maybeSingle()).data?.display_name as string | undefined,
  })
  const safety = useQuery({
    queryKey: ['captain-safety', captainId], enabled: !!captainId && trackingLive,
    queryFn: () => rpc<SafetySummary>('captain_safety_summary', { p_driver: captainId }),
  })
  useLive('driver_profiles', [['captain', captainId]], captainId ? `user_id=eq.${captainId}` : 'user_id=eq.00000000-0000-0000-0000-000000000000')

  const chosen = estimate.data?.categories.find((c) => c.category === cat && c.drivers > 0) ?? estimate.data?.categories.find((c) => c.drivers > 0)
  const nextRadius = RADII.find((r) => r > radius)
  const refreshRide = () => { qc.invalidateQueries({ queryKey: ['rides', uid] }); qc.invalidateQueries({ queryKey: ['ride-group'] }); qc.invalidateQueries({ queryKey: ['ride-events'] }) }

  const request = useMutation({
    mutationFn: () => rpc('request_ride', { p_pickup_label: pickup!.name === 'Current location' || pickup!.name === 'Pinned location' ? `${pickup!.name} (${pickup!.area})` : pickup!.name,
      p_lat: pickup!.lat, p_lng: pickup!.lng, p_drop_label: drop!.name, d_lat: drop!.lat, d_lng: drop!.lng, p_category: chosen!.category, p_radius_m: radius,
      p_prefer_woman: preferWoman }),
    onSuccess: refreshRide,
    onError: (e) => toast.error(friendly(e.message)),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => rpc('cancel_ride', { p_ride: id }),
    onSuccess: () => { refreshRide(); toast('Ride cancelled') },
    onError: (e) => toast.error(friendly(e.message)),
  })
  const retry = useMutation({
    mutationFn: ({ id, dropPref }: { id: string; dropPref: boolean }) => rpc('retry_ride', { p_ride: id, p_drop_preference: dropPref }),
    onSuccess: (_d, v) => { if (v.dropPref) setPreferWoman(false); refreshRide() },
    onError: (e) => toast.error(friendly(e.message)),
  })

  const useMyLocation = async () => {
    const f = await geo.request()
    if (!f) return
    if (!inDemoArea(f.lat, f.lng)) { toast.error("You're outside the Belagavi demo area. Choose a pickup from the list."); return }
    setPickup(pointPlace(f.lat, f.lng, 'gps')); setField(drop ? null : 'drop')
  }
  const pick = (p: Place) => {
    if (field === 'pickup') { setPickup(p); setField(drop ? null : 'drop') } else { setDrop(p); setField(pickup ? null : 'pickup') }
  }

  const pins: Pin[] = showTracker
    ? [{ lat: showTracker.pickup_lat, lng: showTracker.pickup_lng, kind: 'pickup', label: `Pickup: ${showTracker.pickup_label}` },
       { lat: showTracker.drop_lat, lng: showTracker.drop_lng, kind: 'drop', label: `Drop: ${showTracker.drop_label}` }]
    : [pickup && { ...pickup, kind: 'pickup' as const, label: `Pickup: ${pickup.name}` }, drop && { ...drop, kind: 'drop' as const, label: `Drop: ${drop.name}` }].filter(Boolean) as Pin[]
  const route = pins.length === 2 ? pins.map((p) => [p.lat, p.lng] as [number, number]) : undefined
  const c = captain.data
  const mapDrivers: MapDriver[] = showTracker
    ? (c && trackingLive ? [{ id: c.user_id, lat: c.lat, lng: c.lng, label: captainName.data ?? 'Your captain', category: c.vehicle_category, highlight: true }] : [])
    : approxMarkers(estimate.data?.markers ?? availability.data?.markers)
  const fit = c && showTracker && ['accepted', 'arriving'].includes(showTracker.status)
    ? [[c.lat, c.lng], [showTracker.pickup_lat, showTracker.pickup_lng]] as [number, number][]
    : route ?? (pickup ? [[pickup.lat, pickup.lng] as [number, number]] : undefined)
  const choosing = !showTracker && !!pickup && !!drop && !field

  return (
    <>
      <MapFirstLayout
        mapLabel={trackingLive ? <><span className="size-2 rounded-full bg-emerald-500 motion-safe:animate-pulse" />Live trip</> : showTracker ? <><MapPin className="size-3 text-teal-700" aria-hidden />Your trip</> : <><MapPin className="size-3 text-teal-700" aria-hidden />Tap the map to drop a pin</>}
        map={<MapCanvas drivers={mapDrivers} pins={pins} route={route} fit={fit}
          onPick={showTracker ? undefined : (lat, lng) => {
            if (!inDemoArea(lat, lng)) { toast.error('That spot is outside the Belagavi demo area.'); return }
            const p = pointPlace(lat, lng, 'pin')
            if (!pickup || field === 'pickup') { setPickup(p); setField(drop ? null : 'drop') } else { setDrop(p); setField(null) }
          }} />}>
        <Panel aria-label={showTracker ? 'Your ride' : 'Book a ride'}>
          {rides.isLoading ? (
            <div className="space-y-3" aria-busy="true"><Skeleton className="h-6 w-40" /><Skeleton className="h-28 w-full rounded-2xl" /><Skeleton className="h-16 w-full" /></div>
          ) : rides.error ? (
            <LoadError what="your rides" error={rides.error} retry={() => rides.refetch()} />
          ) : showTracker ? (
            <Tracker ride={showTracker} events={events.data ?? []} waiting={!!group.data?.trip_groups?.wait_until && showTracker.status === 'requested'}
              captain={trackingLive ? c ?? undefined : undefined} captainName={captainName.data} safety={safety.data}
              onCancel={() => cancel.mutate(showTracker.id)} cancelling={cancel.isPending}
              onRetry={(dropPref) => retry.mutate({ id: showTracker.id, dropPref })} retrying={retry.isPending}
              onReport={() => setReportOpen(true)} onDone={() => { dismiss(showTracker.id); setDrop(undefined); setField('drop'); qc.invalidateQueries({ queryKey: ['rides', uid] }) }} />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 border-b pb-3">
                <div className="flex items-center gap-2"><h1 className="text-lg font-bold tracking-tight">Where to?</h1><SimBadge /></div>
                <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}><History className="size-3.5" aria-hidden />My rides</Button>
              </div>

              <div className="relative space-y-2">
                <FieldRow kind="pickup" place={pickup} active={field === 'pickup'} onClick={() => setField('pickup')}
                  hint={pickup?.id.startsWith('gps') && geo.fix ? `±${geo.fix.accuracy} m` : undefined} />
                <FieldRow kind="drop" place={drop} active={field === 'drop'} onClick={() => setField('drop')} />
                <button type="button" onClick={() => { setPickup(drop); setDrop(pickup) }} disabled={!pickup || !drop} aria-label="Swap pickup and destination"
                  className="absolute top-1/2 right-3 z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full border bg-white text-slate-600 shadow-sm outline-none hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30">
                  <ArrowUpDown className="size-4" aria-hidden />
                </button>
              </div>

              <div className="no-scrollbar -mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1">
                <Eyebrow className="shrink-0">Quick</Eyebrow>
                {QUICK.map(([id, label]) => (
                  <button key={id} type="button" onClick={() => { const p = placeById(id); if (!pickup || field === 'pickup') { setPickup(p); setField(drop ? null : 'drop') } else { setDrop(p); setField(null) } }}
                    className="h-8 shrink-0 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-200 focus-visible:ring-2 focus-visible:ring-ring">{label}</button>
                ))}
              </div>

              {field && (
                <PlaceSearch key={field} label={field === 'pickup' ? 'Search a pickup landmark' : 'Search a destination'} recents={recents} onPick={pick}
                  onClose={pickup && drop ? () => setField(null) : undefined}
                  extra={field === 'pickup' && (
                    <div className="space-y-1">
                      <Button variant="outline" className="h-11 w-full justify-start rounded-2xl" disabled={geo.status === 'locating'} onClick={useMyLocation}>
                        {geo.status === 'locating' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <LocateFixed className="size-4 text-teal-700" aria-hidden />}
                        {geo.status === 'locating' ? 'Finding your location…' : 'Use my current location'}
                      </Button>
                      <p className="px-1 text-xs text-slate-500" aria-live="polite">{GEO_MESSAGE[geo.status] || 'Used once to set your pickup. Captains see pickup details only after you book.'}</p>
                    </div>
                  )} />
              )}


              {pickup?.id.startsWith('gps') && geo.fix && (geo.fix.accuracy > GOOD_ACCURACY_M || Date.now() - geo.fix.at > STALE_MS) && (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {geo.fix.accuracy > GOOD_ACCURACY_M ? `Low accuracy (±${geo.fix.accuracy} m). Check the pin, or tap the map to correct it.` : 'This location fix is a few minutes old. Tap the pickup to refresh it.'}
                </p>
              )}
              {pickup && !drop && availability.data && (
                <p className="flex items-center gap-1.5 text-sm text-slate-600">
                  <Users className="size-4" aria-hidden />{availability.data.categories.reduce((s, x) => s + x.count, 0)} captains within {km(availability.data.radius_m)} (approximate)
                </p>
              )}

              {choosing && (estimate.isLoading ? (
                <div className="space-y-2" aria-busy="true" aria-label="Loading prices">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[72px] w-full rounded-2xl" />)}</div>
              ) : estimate.error ? (
                <LoadError what="prices" error={estimate.error} retry={() => estimate.refetch()} />
              ) : estimate.data && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <Eyebrow>Choose vehicle</Eyebrow>
                    <span className="text-xs text-slate-500 num">{Number(estimate.data.distance_km).toFixed(1)} km · {estimate.data.categories.reduce((s, x) => s + x.drivers, 0)} captains within {km(radius)}</span>
                  </div>
                  <div role="radiogroup" aria-label="Ride type" className="space-y-2">
                    {estimate.data.categories.map((x) => {
                      const Icon = CAT_ICON[x.category], none = x.drivers === 0, on = chosen?.category === x.category
                      return (
                        <button key={x.category} role="radio" aria-checked={on} disabled={none} onClick={() => setCat(x.category)}
                          className={cn('flex min-h-[72px] w-full items-center gap-3 rounded-2xl border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50',
                            on ? 'border-teal-600 bg-teal-50/70 ring-2 ring-teal-600/25' : 'border-slate-200 bg-slate-50/60 hover:border-slate-300')}>
                          <span className={cn('grid size-11 shrink-0 place-items-center rounded-2xl', on ? 'bg-primary text-white shadow-sm' : 'bg-slate-200 text-slate-600')}>
                            <Icon className="size-6" aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="text-sm font-bold">{CAT_LABEL[x.category]}</span>
                              {Number(x.fare.surge_mult) >= 1.05 && <span className="rounded border border-amber-300 bg-amber-100 px-1 font-mono text-[10px] font-bold text-amber-800" title="Simulated surge">×{Number(x.fare.surge_mult).toFixed(2)}</span>}
                              {x.category === 'bike' && <span className="rounded border border-amber-300 bg-amber-50 px-1 font-mono text-[10px] font-bold text-amber-800" title="Bike taxis need RTA permits in Karnataka; none verified">SIMULATED SERVICE</span>}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                              {none ? `None within ${km(radius)}` : <><span className="flex items-center gap-1"><Clock className="size-3" aria-hidden />{Math.ceil(x.pickup_eta_min ?? 0)} min away</span><span aria-hidden>•</span><span>{Math.round(x.trip_min)} min trip</span></>}
                            </span>
                          </span>
                          <span className="num text-base font-extrabold">{inr(x.fare.total)}</span>
                        </button>
                      )
                    })}
                  </div>
                  {chosen?.category === 'bike' && (
                    <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Bike taxis need an RTA permit in Karnataka and none could be verified, so bike rides here are a simulated demo service.
                    </p>
                  )}
                  {nextRadius && (!chosen || chosen.category !== cat) && (
                    <Button variant="outline" className="w-full" onClick={() => setRadius(nextRadius)}>Search wider: within {km(nextRadius)}</Button>
                  )}

                  <section aria-labelledby="safety-pref" className="rounded-2xl border bg-surface p-3">
                    <Eyebrow className="mb-2" ><span id="safety-pref">Safety preferences</span></Eyebrow>
                    <label className="flex cursor-pointer items-start gap-3">
                      <ShieldCheck className="mt-0.5 size-5 shrink-0 text-teal-700" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">Prefer a woman driver</span>
                        <span className="block text-xs leading-relaxed text-slate-500">Request a woman driver for additional comfort. Availability may vary by location and time.</span>
                      </span>
                      <Switch checked={preferWoman} onCheckedChange={setPreferWoman} aria-label="Prefer a woman driver" className="mt-0.5" />
                    </label>
                  </section>

                  {chosen && (
                    <details className="group rounded-2xl border bg-white px-3">
                      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="font-semibold">How this fare is calculated</span>
                        <ChevronRight className="size-4 text-slate-400 transition-transform group-open:rotate-90" aria-hidden />
                      </summary>
                      <div className="space-y-2 pb-3">
                        <FareBreakdown fare={chosen.fare} />
                        <p className="text-xs text-slate-500">About {Number(estimate.data.distance_km).toFixed(1)} km: a straight-line estimate × 1.35, not a road route. The {Math.round(chosen.trip_min)}-min trip time is an estimate and does not change the fare (no per-minute charge). Price fixed at booking.</p>
                      </div>
                    </details>
                  )}
                  {chosen && Number(chosen.fare.surge_mult) > 1 && estimate.data.zone && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-800">
                      <TrendingUp className="mt-0.5 size-3 shrink-0" aria-hidden />
                      <span>×{Number(chosen!.fare.surge_mult).toFixed(2)} surge (simulated, capped at 2×): {Number(estimate.data.zone.forecast).toFixed(1)} rides forecast vs {estimate.data.zone.supply} free captains in {estimate.data.zone.name}.</span>
                    </p>
                  )}
                </div>
              ))}

              {pickup && drop && <ActionBar>
                <Button size="lg" className="h-13 w-full justify-between rounded-2xl px-5 text-[15px] font-bold shadow-lg shadow-teal-700/25" disabled={!choosing || !chosen || request.isPending} onClick={() => request.mutate()}>
                  <span className="flex items-center gap-2">{request.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                    {chosen && choosing ? `Confirm ${CAT_LABEL[chosen.category]}` : !pickup || !drop ? 'Choose pickup and destination' : estimate.isLoading ? 'Getting prices…' : field ? 'Pick a place to continue' : `No captains within ${km(radius)}`}</span>
                  {chosen && choosing && <span className="num font-mono font-medium text-teal-100">{inr(chosen.fare.total)}</span>}
                </Button>
                <p className="mt-2 text-center text-[11px] text-slate-500" aria-live="polite">
                  {choosing && preferWoman ? 'Woman driver requested. We will ask before matching anyone else.' : choosing ? 'Matched automatically to the best nearby captain.' : 'Pick both places to see live fares.'}
                </p>
              </ActionBar>}
            </div>
          )}
        </Panel>
      </MapFirstLayout>

      <HistorySheet open={historyOpen} onOpenChange={setHistoryOpen} rides={rides.data ?? []} phone={phone} />
      {showTracker && <ReportSheet open={reportOpen} onOpenChange={setReportOpen} ride={showTracker} phone={phone} />}
    </>
  )
}

function FieldRow({ kind, place, active, onClick, hint }: { kind: 'pickup' | 'drop'; place?: Place; active: boolean; onClick: () => void; hint?: string }) {
  const label = kind === 'pickup' ? 'Pickup point' : 'Destination'
  return (
    <button type="button" onClick={onClick} aria-label={`${label}: ${place?.name ?? 'not set'}. Change`}
      className={cn('flex min-h-14 w-full items-center gap-3 rounded-2xl border bg-slate-50 py-2 pr-14 pl-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-teal-500/30',
        active ? 'border-teal-500 bg-white ring-2 ring-teal-500/20' : 'border-slate-200 hover:border-slate-300')}>
      <span aria-hidden className={cn('size-3 shrink-0', kind === 'pickup' ? 'rounded-full bg-emerald-600' : 'rounded-[3px] bg-rose-600')} />
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-bold tracking-wide text-slate-500 uppercase">{label}</span>
        <span className={cn('block truncate text-sm font-semibold', !place && 'font-medium text-slate-400')}>{place?.name ?? (kind === 'pickup' ? 'Where should we pick you up?' : 'Where are you going?')}</span>
        {place && <span className="block truncate text-xs text-slate-500">{place.area}{hint && ` · ${hint}`}</span>}
      </span>
    </button>
  )
}

function Tracker({ ride, events, waiting, captain, captainName, safety, onCancel, cancelling, onRetry, retrying, onReport, onDone }: {
  ride: RideX; events: Ev[]; waiting: boolean; captain?: Captain; captainName?: string; safety?: SafetySummary
  onCancel: () => void; cancelling: boolean; onRetry: (dropPref: boolean) => void; retrying: boolean; onReport: () => void; onDone: () => void
}) {
  const searching = ride.status === 'requested' || ride.status === 'offered'
  const live = ['accepted', 'arriving', 'ongoing'].includes(ride.status)
  const eta = ride.est_pickup_min != null && ['accepted', 'arriving'].includes(ride.status) ? Math.ceil(ride.est_pickup_min) : null
  const age = captain?.location_updated_at ? Math.round((Date.now() - new Date(captain.location_updated_at).getTime()) / 1000) : null
  const msg = riderMessage(ride, events, waiting)
  const sl = safetyLabel(safety)
  const RouteCard = (
    <div className="space-y-2 rounded-2xl border bg-surface p-3 text-sm">
      <div className="flex items-center gap-2"><MapPin className="size-4 shrink-0 text-emerald-600" aria-hidden /><span className="sr-only">Pickup:</span><span className="truncate">{ride.pickup_label}</span></div>
      <div className="flex items-center gap-2"><Navigation className="size-4 shrink-0 text-rose-600" aria-hidden /><span className="sr-only">Drop:</span><span className="truncate">{ride.drop_label}</span></div>
    </div>
  )

  if (searching || ride.status === 'no_driver_found') return (
    <div className="space-y-4">
      <div className="py-2 text-center" aria-live="polite">
        {ride.status === 'no_driver_found' ? (
          <span className="mx-auto mb-3 grid size-16 place-items-center rounded-full border border-rose-200 bg-rose-50 text-rose-600"><XCircle className="size-8" aria-hidden /></span>
        ) : (
          <span className="relative mx-auto mb-3 grid size-16 place-items-center rounded-full border border-teal-200 bg-teal-50 text-teal-700">
            <Loader2 className="size-8 motion-safe:animate-spin" aria-hidden />
            <span aria-hidden className="absolute -top-1 -right-1 size-4 rounded-full bg-teal-500 opacity-75 motion-safe:animate-ping" />
          </span>
        )}
        <div className="flex items-center justify-center gap-2"><h1 className="text-lg font-bold">{msg.title}</h1><SimBadge /></div>
        {ride.attempt_no > 0 && <span className="mt-2 inline-block rounded-full border bg-slate-100 px-3 py-1 font-mono text-xs font-semibold text-teal-800">Attempt {ride.attempt_no}</span>}
        <p className="mx-auto mt-2 max-w-xs text-xs text-slate-500">
          {ride.status === 'no_driver_found'
            ? ride.women_driver_pref ? 'No woman captain is free near your pickup right now. You decide what happens next.' : 'Every nearby captain is busy or declined. You can keep searching.'
            : waiting ? 'We retry automatically for a few minutes. You can change your mind below.'
            : 'Matching you with the best captain nearby: closest arrival, balanced workload and where drivers are needed.'}
        </p>
      </div>

      <div className="space-y-2 rounded-2xl border bg-surface p-3 text-sm">
        <div className="flex items-center justify-between"><span className="font-bold">{CAT_LABEL[ride.category]}</span><span className="num font-mono text-base font-bold text-teal-800">{inr(ride.fare.total)}</span></div>
        <div className="flex items-center gap-2 text-slate-600"><MapPin className="size-4 shrink-0 text-emerald-600" aria-hidden /><span className="truncate">{ride.pickup_label}</span></div>
        <div className="flex items-center gap-2 text-slate-600"><Navigation className="size-4 shrink-0 text-rose-600" aria-hidden /><span className="truncate">{ride.drop_label}</span></div>
        {ride.women_driver_pref && <Tag tone="brand"><ShieldCheck className="size-3.5" aria-hidden />Woman driver requested</Tag>}
      </div>

      {events.length > 0 && <RideTimeline events={events} />}

      <ActionBar>
        {ride.status === 'no_driver_found' ? (
          <div className="space-y-2">
            {ride.women_driver_pref ? <>
              <Button size="lg" className="w-full" disabled={retrying} onClick={() => onRetry(false)}>{retrying ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}Keep waiting for a woman captain</Button>
              <Button size="lg" variant="outline" className="w-full" disabled={retrying} onClick={() => onRetry(true)}>Search all captains instead</Button>
            </> : <Button size="lg" className="w-full" disabled={retrying} onClick={() => onRetry(false)}>{retrying ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}Keep searching</Button>}
            <Button variant="ghost" className="w-full" onClick={onDone}>Change my ride</Button>
          </div>
        ) : (
          <div className="space-y-2">
            {waiting && ride.women_driver_pref && <Button size="lg" variant="outline" className="w-full" disabled={retrying} onClick={() => onRetry(true)}>Search all captains instead</Button>}
            <Button variant="outline" className="w-full hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700" onClick={onCancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <XCircle className="size-4" aria-hidden />}Cancel ride request
            </Button>
          </div>
        )}
      </ActionBar>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 border-b pb-4" aria-live="polite">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><h1 className="text-lg font-bold tracking-tight">{ride.status === 'completed' ? "You've arrived" : msg.title}</h1><SimBadge /></div>
          <p className="mt-0.5 text-xs text-slate-500">
            {ride.status === 'arriving' || ride.status === 'accepted' ? `Meet at ${ride.pickup_label}` : ride.status === 'ongoing' ? `Heading to ${ride.drop_label} (${Math.round(ride.est_trip_min)} min)`
              : ride.status === 'completed' ? `Dropped at ${ride.drop_label}` : 'This ride was cancelled'}
          </p>
        </div>
        <div className="shrink-0 text-right"><div className="text-xs text-slate-500">Total fare</div><div className="num font-mono text-lg font-extrabold text-teal-800">{inr(ride.fare.total)}</div></div>
      </div>

      {ride.status !== 'cancelled' && <StatusStepper status={ride.status} />}

      {ride.attempt_no > 1 && live && (
        <p className="flex items-start gap-2 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-800">
          <RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden /><span>Reassigned automatically: your first captain became unavailable, so we found you another.</span>
        </p>
      )}

      {captainName && ride.status !== 'cancelled' && (
        <div className="space-y-3 rounded-2xl border bg-surface p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-12 shrink-0 place-items-center rounded-xl border border-teal-200 bg-teal-50 text-lg font-bold text-teal-800" aria-hidden>{captainName.replace('Captain ', '')[0]}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold">{captainName}</div>
              {captain && <div className="truncate text-xs text-slate-500">{captain.vehicle_label}</div>}
              <div className="mt-0.5 text-[11px] font-semibold tracking-wide text-teal-800 uppercase">{CAT_LABEL[ride.category]}</div>
            </div>
            <div className="shrink-0 text-right">
              {captain && <span className="rounded-md border-2 border-slate-800 bg-white px-1.5 py-0.5 font-mono text-xs font-bold tracking-wider" aria-label={`Number plate ${captain.plate}`}>{captain.plate}</span>}
              {eta != null && <div className="mt-1.5 flex items-center justify-end gap-1 font-mono text-sm font-bold"><Clock className="size-3.5 text-teal-700" aria-hidden />{eta} min</div>}
            </div>
          </div>
          {live && (
            <div className="flex items-start gap-2 border-t pt-3 text-xs">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-teal-700" aria-hidden />
              <div><span className="font-semibold">{sl.headline}</span> <span className="text-slate-500">{sl.detail}</span></div>
            </div>
          )}
          {live && (
            <p className="text-[11px] text-slate-500">
              {captain?.location_source === 'simulated' ? 'Live position: simulated captain' : age == null ? 'Live position unavailable'
                : `Live position ${captain?.location_source === 'gps' ? 'from GPS' : '(manual pin)'} · updated ${age < 60 ? `${age}s` : `${Math.round(age / 60)} min`} ago`}
            </p>
          )}
        </div>
      )}

      {RouteCard}

      {ride.status === 'completed' && <SafetyFeedback ride={ride} onReport={onReport} />}

      {ride.status !== 'completed' && (
        <details className="group rounded-2xl border bg-white px-3">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="font-semibold">Fare · {CAT_LABEL[ride.category]}</span>
            <span className="flex items-center gap-1 font-semibold num">{inr(ride.fare.total)}<ChevronRight className="size-4 text-slate-400 transition-transform group-open:rotate-90" aria-hidden /></span>
          </summary>
          <div className="pb-3"><FareBreakdown fare={ride.fare} /></div>
        </details>
      )}

      <ActionBar>
        {ride.status === 'completed' || ride.status === 'cancelled' ? (
          <Button size="lg" className="w-full" onClick={onDone}>Book another ride</Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onReport}><ShieldAlert className="size-4 text-rose-600" aria-hidden />Safety concern</Button>
            {ride.status !== 'ongoing' && (
              <Button variant="outline" className="flex-1 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700" onClick={onCancel} disabled={cancelling}>
                {cancelling ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <XCircle className="size-4" aria-hidden />}Cancel ride
              </Button>
            )}
          </div>
        )}
      </ActionBar>
    </div>
  )
}

const EV_TEXT: Record<string, string> = {
  ride_requested: 'Request received', offer_created: 'Captain notified', offer_accepted: 'Captain accepted',
  offer_rejected: 'Captain declined', offer_no_response: 'Captain did not respond', offer_cancelled: 'Captain no longer available',
  driver_cancelled: 'Captain cancelled', arrival_delayed: 'Captain delayed', captain_unreachable: 'Captain unreachable',
  still_searching: 'Still searching', search_restarted: 'Search restarted', no_driver_found: 'No captain available',
  status_arriving: 'Captain on the way', status_ongoing: 'Trip started', status_completed: 'Trip completed', rider_cancelled: 'You cancelled',
}
function RideTimeline({ events }: { events: Ev[] }) {
  return (
    <div>
      <Eyebrow className="mb-2">What's happening</Eyebrow>
      <ol className="max-h-36 space-y-1.5 overflow-y-auto pr-1">
        {events.slice(0, 6).map((e) => (
          <li key={e.id} className="flex items-center gap-2 rounded-xl border bg-surface px-2.5 py-1.5 text-xs">
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', FAIL.includes(e.type) || e.type === 'no_driver_found' ? 'bg-rose-500' : 'bg-teal-600')} />
            <span className="flex-1 font-semibold">{EV_TEXT[e.type] ?? 'Update'}</span>
            <time className="num text-slate-500">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          </li>
        ))}
      </ol>
    </div>
  )
}

const LEVELS = ['Very unsafe', 'Unsafe', 'Okay', 'Safe', 'Very safe']
function Scale({ label, value, onChange, required }: { label: string; value: number | null; onChange: (v: number) => void; required?: boolean }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-semibold">{label}{!required && <span className="font-normal text-slate-500"> (optional)</span>}</legend>
      <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n}: ${LEVELS[n - 1]}`} onClick={() => onChange(n)}
            className={cn('h-11 rounded-xl border text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring num',
              value === n ? 'border-teal-600 bg-primary text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300')}>{n}</button>
        ))}
      </div>
      {required && <div className="flex justify-between text-[11px] text-slate-500"><span>Very unsafe</span><span>Very safe</span></div>}
    </fieldset>
  )
}

/** Separate from any star rating. Optional; one entry per trip, enforced by the database. */
function SafetyFeedback({ ride, onReport }: { ride: RideX; onReport: () => void }) {
  const qc = useQueryClient()
  const [overall, setOverall] = useState<number | null>(null)
  const [driving, setDriving] = useState<number | null>(null)
  const [vehicle, setVehicle] = useState<number | null>(null)
  const [conduct, setConduct] = useState<number | null>(null)
  const [comment, setComment] = useState('')
  const [skipped, setSkipped] = useState(false)
  const existing = useQuery({
    queryKey: ['ride-feedback', ride.id],
    queryFn: async () => (await supabase.from('safety_feedback').select('overall').eq('ride_id', ride.id).maybeSingle()).data as { overall: number } | null,
  })
  const submit = useMutation({
    mutationFn: () => rpc('submit_safety_feedback', { p_ride: ride.id, p_overall: overall, p_driving: driving, p_vehicle: vehicle, p_conduct: conduct, p_comment: comment || null }),
    onSuccess: () => { toast.success('Thanks. Your safety feedback was recorded.'); qc.invalidateQueries({ queryKey: ['ride-feedback', ride.id] }) },
    onError: (e) => toast.error(friendly(e.message)),
  })
  if (existing.isLoading) return <Skeleton className="h-24 w-full rounded-2xl" />
  if (existing.data) return (
    <div className="flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
      <Check className="mt-0.5 size-4 shrink-0" aria-hidden /><span>Safety feedback sent. <button type="button" className="font-semibold underline underline-offset-2" onClick={onReport}>Report a concern</button> if something needs our attention.</span>
    </div>
  )
  if (skipped) return <button type="button" onClick={onReport} className="text-sm font-semibold text-rose-700 underline underline-offset-2">Report a safety concern</button>
  return (
    <section aria-labelledby="sf-title" className="space-y-4 rounded-2xl border bg-white p-4">
      <div>
        <h2 id="sf-title" className="text-base font-bold">How safe did you feel?</h2>
        <p className="text-xs text-slate-500">Optional. Kept separate from fares and ratings; captains see only an anonymous average, never your name.</p>
      </div>
      <Scale label="Overall feeling of safety" value={overall} onChange={setOverall} required />
      {overall != null && <>
        <Scale label="Driving behaviour" value={driving} onChange={setDriving} />
        <Scale label="Vehicle condition" value={vehicle} onChange={setVehicle} />
        <Scale label="Captain's conduct" value={conduct} onChange={setConduct} />
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold">Comments <span className="font-normal text-slate-500">(optional)</span></span>
          <textarea value={comment} onChange={(e) => setComment(e.target.value.slice(0, 500))} rows={3} placeholder="Anything we should know?"
            className="w-full rounded-xl border bg-white p-3 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20" />
          <span className="block text-right text-[11px] text-slate-500 num">{comment.length}/500</span>
        </label>
      </>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={overall == null || submit.isPending} onClick={() => submit.mutate()}>{submit.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}Send feedback</Button>
        <Button variant="ghost" onClick={() => setSkipped(true)}>Skip</Button>
        <Button variant="ghost" className="text-rose-700 hover:text-rose-800" onClick={onReport}><ShieldAlert className="size-4" aria-hidden />Report a concern</Button>
      </div>
    </section>
  )
}

const CATEGORIES = [
  ['unsafe_driving', 'Unsafe driving'], ['harassment', 'Harassment or inappropriate behaviour'], ['vehicle_condition', 'Vehicle condition'],
  ['route_deviation', 'Unexpected route'], ['other', 'Something else'],
] as const
function ReportSheet({ open, onOpenChange, ride, phone }: { open: boolean; onOpenChange: (v: boolean) => void; ride: RideX; phone: boolean }) {
  const qc = useQueryClient()
  const [category, setCategory] = useState<string>('unsafe_driving')
  const [text, setText] = useState('')
  const mine = useQuery({
    queryKey: ['ride-report', ride.id], enabled: open,
    queryFn: async () => (await supabase.from('safety_reports').select('status, created_at').eq('ride_id', ride.id).maybeSingle()).data as { status: string; created_at: string } | null,
  })
  const submit = useMutation({
    mutationFn: () => rpc('submit_safety_report', { p_ride: ride.id, p_category: category, p_description: text }),
    onSuccess: () => { toast.success('Report received. Our safety team reviews every report.'); setText(''); qc.invalidateQueries({ queryKey: ['ride-report', ride.id] }) },
    onError: (e) => toast.error(friendly(e.message)),
  })
  const tooShort = text.trim().length < 10
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={phone ? 'bottom' : 'right'} className={cn('bg-white', phone && 'max-h-[90dvh] rounded-t-3xl pb-[env(safe-area-inset-bottom)]')}>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><ShieldAlert className="size-5 text-rose-600" aria-hidden />Report a safety concern</SheetTitle>
          <SheetDescription>About your trip from {ride.pickup_label} to {ride.drop_label}. Your name is never shown to the captain. In an emergency, call 112 first.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          {mine.data ? (
            <Empty icon={<Check className="mt-0.5 size-4 text-emerald-600" aria-hidden />}>
              You reported this trip on {new Date(mine.data.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Status: <b>{mine.data.status.replace('_', ' ')}</b>. A reviewer will look at it; one report per trip.
            </Empty>
          ) : <>
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-sm font-semibold">What happened?</legend>
              {CATEGORIES.map(([v, l]) => (
                <label key={v} className={cn('flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 text-sm', category === v ? 'border-teal-600 bg-teal-50/60' : 'border-slate-200')}>
                  <input type="radio" name="cat" value={v} checked={category === v} onChange={() => setCategory(v)} className="size-4 accent-teal-700" />{l}
                </label>
              ))}
            </fieldset>
            <label className="block space-y-1.5">
              <span className="text-sm font-semibold">Describe it</span>
              <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 2000))} rows={5} placeholder="What happened, and roughly when during the trip?"
                className="w-full rounded-xl border bg-white p-3 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20" aria-describedby="rep-hint" />
              <span id="rep-hint" className="block text-[11px] text-slate-500">At least 10 characters. A reviewer reads every report; nothing happens to the captain automatically.</span>
            </label>
            <Button size="lg" className="w-full" disabled={tooShort || submit.isPending} onClick={() => submit.mutate()}>{submit.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}Submit report</Button>
          </>}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function HistorySheet({ open, onOpenChange, rides, phone }: { open: boolean; onOpenChange: (v: boolean) => void; rides: RideX[]; phone: boolean }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={phone ? 'bottom' : 'right'} className={cn('bg-white', phone && 'max-h-[85dvh] rounded-t-3xl pb-[env(safe-area-inset-bottom)]')}>
        <SheetHeader>
          <SheetTitle>My rides</SheetTitle>
          <SheetDescription>Last 30 trips with their fare breakdown.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          {!rides.length ? <Empty>No rides yet. Completed and cancelled trips appear here.</Empty> : rides.map((r) => (
            <details key={r.id} className="group rounded-2xl border bg-surface px-3 open:bg-white">
              <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{r.drop_label}</span>
                  <span className="block truncate text-xs text-slate-500">from {r.pickup_label} · {new Date(r.requested_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </span>
                <span className="shrink-0 space-y-1 text-right">
                  <span className="block text-sm font-bold num">{inr(r.fare.total)}</span>
                  <StatusChip status={r.status} short />
                </span>
                <ChevronRight className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-90" aria-hidden />
              </summary>
              <div className="pb-3"><FareBreakdown fare={r.fare} /></div>
            </details>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}

const KEY = 'up.dismissed'
function dismissed(id: string) { try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]).includes(id) } catch { return false } }
function dismiss(id: string) { try { localStorage.setItem(KEY, JSON.stringify([id])) } catch { /* private mode */ } }
