import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowDownUp, ChevronRight, Clock, History, Loader2, LocateFixed, MapPin, RefreshCw, Search, TrendingUp, Users } from 'lucide-react'
import { MapCanvas, type MapDriver, type MapPin as Pin } from '@/components/map/MapCanvas'
import { MapShell } from '@/components/layout/MapShell'
import { Brand, CAT_ICON, CAT_LABEL, Empty, FareBreakdown, LoadError, SignOutButton, SimBadge, StatusChip, StatusStepper, statusText } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/lib/auth'
import { useLive, usePhone, useSweep } from '@/lib/hooks'
import { GEO_MESSAGE, GOOD_ACCURACY_M, STALE_MS, useCurrentPosition } from '@/lib/geolocation'
import { inDemoArea, pointPlace, searchPlaces, type Place } from '@/lib/places'
import { rpc, supabase, type Ride } from '@/lib/supabase'
import { inr } from '@/lib/geo'
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
const ACTIVE = ['requested', 'offered', 'accepted', 'arriving', 'ongoing']
const RADII = [2000, 3000, 5000] as const
const km = (m: number) => `${m / 1000} km`
const approxMarkers = (ms: Marker[] = []): MapDriver[] =>
  ms.map((m, i) => ({ id: `a${i}`, lat: m.lat, lng: m.lng, label: 'Captains nearby', category: m.category, approx: true, n: m.n }))

/** Search over demo landmarks + the rider's own recent places. Picks one place for the field being edited. */
function PlaceSearch({ label, recents, onPick, autoFocus }: { label: string; recents: Place[]; onPick: (p: Place) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState('')
  const hits = searchPlaces(q)
  const recentHits = recents.filter((r) => !q || `${r.name} ${r.area}`.toLowerCase().includes(q.trim().toLowerCase()))
  const row = (p: Place, icon: React.ReactNode) => (
    <li key={p.id}>
      <button type="button" onClick={() => onPick(p)}
        className="flex min-h-12 w-full items-center gap-3 rounded-xl px-2 text-left outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>{icon}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{p.name}</span><span className="block truncate text-xs text-muted-foreground">{p.area}</span></span>
      </button>
    </li>
  )
  return (
    <div className="space-y-2">
      <label className="flex h-12 items-center gap-2 rounded-xl bg-muted/70 px-3 focus-within:ring-2 focus-within:ring-ring">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="sr-only">{label}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} placeholder={label} enterKeyHint="search"
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground" />
      </label>
      <div className="max-h-[36dvh] overflow-y-auto overscroll-contain md:max-h-[40dvh]">
        {recentHits.length > 0 && <>
          <p className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">Recent</p>
          <ul>{recentHits.slice(0, 4).map((p) => row(p, <Clock className="size-4" />))}</ul>
        </>}
        <p className="px-2 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">Demo places, Belagavi (from OpenStreetMap)</p>
        {hits.length ? <ul>{hits.map((p) => row(p, <MapPin className="size-4" />))}</ul>
          : <p className="px-2 py-3 text-sm text-muted-foreground">No demo place matches “{q}”. Try another name, or tap the map to drop a pin.</p>}
      </div>
    </div>
  )
}

/** Compact pickup → destination summary; tapping a row edits that field. */
function RouteSummary({ pickup, drop, onEdit, onSwap }: { pickup: Place; drop: Place; onEdit: (f: 'pickup' | 'drop') => void; onSwap: () => void }) {
  const row = (f: 'pickup' | 'drop', p: Place) => (
    <button type="button" onClick={() => onEdit(f)} className="flex min-h-12 w-full min-w-0 flex-col justify-center text-left outline-none focus-visible:underline" aria-label={`Change ${f}: ${p.name}`}>
      <span className="truncate text-[15px]">{p.name}</span><span className="truncate text-xs text-muted-foreground">{p.area}</span>
    </button>
  )
  return (
    <div className="flex items-stretch gap-3 rounded-2xl bg-muted/70 pr-2 pl-4">
      <div className="flex flex-col items-center py-[22px]" aria-hidden>
        <span className="size-2.5 rounded-full bg-primary" /><span className="w-px flex-1 bg-foreground/25" /><span className="size-2.5 rounded-[3px] bg-foreground" />
      </div>
      <div className="min-w-0 flex-1 divide-y divide-foreground/10">{row('pickup', pickup)}{row('drop', drop)}</div>
      <Button type="button" variant="ghost" size="icon" className="self-center rounded-full" aria-label="Swap pickup and destination" onClick={onSwap}>
        <ArrowDownUp className="size-4" aria-hidden />
      </Button>
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
  const [field, setField] = useState<'pickup' | 'drop'>('pickup')
  const [cat, setCat] = useState<Cat>('bike')
  const [radius, setRadius] = useState<(typeof RADII)[number]>(2000)
  const [historyOpen, setHistoryOpen] = useState(false)
  const setPickup = (p?: Place) => { setPickupRaw(p); setRadius(2000) }
  useSweep()
  useLive('rides', [['rides', uid]], `rider_id=eq.${uid}`)

  const rides = useQuery({
    queryKey: ['rides', uid],
    queryFn: async () => {
      const { data, error } = await supabase.from('rides').select('*').eq('rider_id', uid).order('requested_at', { ascending: false }).limit(30)
      if (error) throw error
      return data as Ride[]
    },
  })
  const active = rides.data?.find((r) => ACTIVE.includes(r.status))
  const latest = rides.data?.[0]
  const showTracker = active ?? (latest && Date.now() - new Date(latest.requested_at).getTime() < 10 * 60e3 && !dismissed(latest.id) ? latest : undefined)
  const captainId = showTracker?.driver_id ?? undefined
  const trackingLive = !!showTracker && ['accepted', 'arriving', 'ongoing'].includes(showTracker.status)

  // Recent places come from the rider's own trips (named landmarks only, not old GPS fixes).
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
    enabled: !!pickup && !drop && !active,
    queryFn: () => rpc<Availability>('nearby_availability', { p_lat: pickup!.lat, p_lng: pickup!.lng, p_radius_m: radius }),
  })
  const estimate = useQuery({
    queryKey: ['estimate', pickup?.lat, pickup?.lng, drop?.lat, drop?.lng, radius],
    enabled: !!pickup && !!drop && !active,
    queryFn: () => rpc<Estimate>('estimate_ride', { p_lat: pickup!.lat, p_lng: pickup!.lng, d_lat: drop!.lat, d_lng: drop!.lng, p_radius_m: radius }),
  })
  // After a match: the assigned captain's precise row. The database only returns it to this rider, during the trip.
  const captain = useQuery({
    queryKey: ['captain', captainId],
    enabled: !!captainId && trackingLive,
    queryFn: async () => (await supabase.from('driver_profiles').select('user_id, lat, lng, vehicle_category, vehicle_label, plate, location_updated_at, location_source').eq('user_id', captainId!).maybeSingle()).data as Captain | null,
  })
  const captainName = useQuery({
    queryKey: ['captain-name', captainId], enabled: !!captainId,
    queryFn: async () => (await supabase.from('profiles').select('display_name').eq('id', captainId!).maybeSingle()).data?.display_name as string | undefined,
  })
  useLive('driver_profiles', [['captain', captainId]], captainId ? `user_id=eq.${captainId}` : 'user_id=eq.00000000-0000-0000-0000-000000000000')

  const chosen = estimate.data?.categories.find((c) => c.category === cat && c.drivers > 0) ?? estimate.data?.categories.find((c) => c.drivers > 0)
  const nextRadius = RADII.find((r) => r > radius)

  const request = useMutation({
    mutationFn: () => rpc('request_ride', { p_pickup_label: pickup!.name === 'Current location' || pickup!.name === 'Pinned location' ? `${pickup!.name} (${pickup!.area})` : pickup!.name,
      p_lat: pickup!.lat, p_lng: pickup!.lng, p_drop_label: drop!.name, d_lat: drop!.lat, d_lng: drop!.lng, p_category: chosen!.category, p_radius_m: radius }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rides', uid] }),
    onError: (e) => toast.error(e.message),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => rpc('cancel_ride', { p_ride: id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rides', uid] }); toast('Ride cancelled') },
    onError: (e) => toast.error(e.message),
  })

  const useMyLocation = async () => {
    const f = await geo.request()
    if (!f) return
    if (!inDemoArea(f.lat, f.lng)) { toast.error("You're outside the Belagavi demo area. Choose a pickup from the list."); return }
    setPickup(pointPlace(f.lat, f.lng, 'gps')); setField('drop')
  }
  const pick = (p: Place) => {
    if (field === 'pickup') { setPickup(p); if (!drop) setField('drop') } else { setDrop(p) }
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
  const finished = showTracker && !ACTIVE.includes(showTracker.status)
  const choosing = !showTracker && !!pickup && !!drop
  const firstRun = !showTracker && !choosing

  const footer = rides.isLoading || rides.error ? undefined : showTracker ? (
    finished
      ? <Button className="h-12 w-full text-[15px]" onClick={() => { dismiss(showTracker.id); qc.invalidateQueries({ queryKey: ['rides', uid] }) }}>Book another ride</Button>
      : ['requested', 'offered', 'accepted', 'arriving'].includes(showTracker.status)
        ? <Button variant="outline" className="h-12 w-full text-[15px]" onClick={() => cancel.mutate(showTracker.id)} disabled={cancel.isPending}>
            {cancel.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}Cancel ride</Button>
        : undefined
  ) : choosing ? (
    <Button className="h-12 w-full justify-between px-5 text-[15px]" disabled={!chosen || request.isPending} onClick={() => request.mutate()}>
      <span className="flex items-center gap-2">{request.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {chosen ? `Request ${CAT_LABEL[chosen.category]}` : estimate.isLoading ? 'Getting prices…' : `No captains within ${km(radius)}`}</span>
      {chosen && <span className="tabular-nums">{inr(chosen.fare.total)}</span>}
    </Button>
  ) : undefined

  return (
    <>
      <MapShell label={showTracker ? 'Your ride' : 'Book a ride'} footer={footer} dim={firstRun && !pickup} tall={firstRun}
        topLeft={<><Brand compact /><SimBadge className="hidden sm:inline-flex" /></>}
        topRight={<>
          <SimBadge className="mr-1 sm:hidden" />
          <Button variant="ghost" size="sm" className="h-8 rounded-full" onClick={() => setHistoryOpen(true)} aria-label="Ride history">
            <History className="size-4" aria-hidden /><span className="hidden sm:inline">History</span>
          </Button>
          <SignOutButton className="size-8 rounded-full" />
        </>}
        map={<MapCanvas panel drivers={mapDrivers} pins={pins} route={route} fit={fit}
          onPick={showTracker ? undefined : (lat, lng) => {
            if (!inDemoArea(lat, lng)) return
            const p = pointPlace(lat, lng, 'pin')
            if (!pickup || field === 'pickup') { setPickup(p); setField('drop') } else setDrop(p)
          }} />}>
        {rides.isLoading ? (
          <div className="space-y-3 pt-1"><Skeleton className="h-6 w-40" /><Skeleton className="h-24 w-full rounded-2xl" /><Skeleton className="h-16 w-full" /></div>
        ) : rides.error ? (
          <LoadError what="your rides" error={rides.error} retry={() => rides.refetch()} />
        ) : showTracker ? (
          <Tracker ride={showTracker} captain={trackingLive ? c ?? undefined : undefined} captainName={captainName.data} />
        ) : choosing ? (
          <div className="space-y-4 pt-1">
            <RouteSummary pickup={pickup} drop={drop} onSwap={() => { setPickup(drop); setDrop(pickup) }}
              onEdit={(f) => { setField(f); if (f === 'pickup') setPickup(undefined); else setDrop(undefined) }} />
            {estimate.isLoading ? (
              <div className="space-y-2" aria-busy="true" aria-label="Loading prices">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[68px] w-full rounded-xl" />)}</div>
            ) : estimate.error ? (
              <LoadError what="prices" error={estimate.error} retry={() => estimate.refetch()} />
            ) : estimate.data && (
              <div className="space-y-3">
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Users className="size-4" aria-hidden />
                  <span><span className="font-medium text-foreground tabular-nums">{estimate.data.categories.reduce((s, x) => s + x.drivers, 0)}</span> captains within {km(radius)} · shown approximately</span>
                </p>
                <div role="radiogroup" aria-label="Ride type" className="space-y-1.5">
                  {estimate.data.categories.map((x) => {
                    const Icon = CAT_ICON[x.category], none = x.drivers === 0, on = chosen?.category === x.category
                    return (
                      <button key={x.category} role="radio" aria-checked={on} disabled={none} onClick={() => setCat(x.category)}
                        className={cn('flex min-h-[68px] w-full items-center gap-3 rounded-xl px-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45',
                          on ? 'bg-primary/8 ring-2 ring-primary' : 'hover:bg-muted')}>
                        <span className={cn('grid size-11 shrink-0 place-items-center rounded-xl', on ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>
                          <Icon className="size-5" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="font-medium">{CAT_LABEL[x.category]}</span>
                            {!none && <span className="text-sm text-muted-foreground tabular-nums">~{Math.ceil(x.pickup_eta_min ?? 0)} min away</span>}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            {none ? `No ${CAT_LABEL[x.category].toLowerCase()} within ${km(radius)}` : <>{x.drivers} nearby · {Math.round(x.trip_min)} min trip</>}
                          </span>
                        </span>
                        <span className="text-right text-base font-semibold tabular-nums">{inr(x.fare.total)}</span>
                      </button>
                    )
                  })}
                </div>
                {nextRadius && (!chosen || chosen.category !== cat) && (
                  <Button variant="outline" className="w-full" onClick={() => setRadius(nextRadius)}>
                    Search wider: within {km(nextRadius)}
                  </Button>
                )}
                {chosen && (
                  <details className="group rounded-xl bg-muted/50 px-3">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="font-medium">How this fare is calculated</span>
                      <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
                    </summary>
                    <div className="space-y-2 pb-3">
                      <FareBreakdown fare={chosen.fare} />
                      <p className="text-xs text-muted-foreground">
                        {Number(estimate.data.distance_km).toFixed(1)} km and {Math.round(chosen.trip_min)} min, estimated from straight-line distance × 1.35 and time-of-day speed. Fixed at booking.
                      </p>
                    </div>
                  </details>
                )}
                {estimate.data.surge > 1 && estimate.data.zone && (
                  <p className="flex items-start gap-1.5 text-xs text-warning">
                    <TrendingUp className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span>×{estimate.data.surge.toFixed(2)} surge (simulated): {Number(estimate.data.zone.forecast).toFixed(1)} rides forecast vs {estimate.data.zone.supply} free captains in {estimate.data.zone.name}.</span>
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{pickup ? 'Where to?' : 'Where are you going?'}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{pickup ? 'Search a destination, or tap the map to drop a pin.' : 'Start with your pickup point.'}</p>
            </div>

            {pickup ? (
              <button type="button" onClick={() => { setField('pickup'); setPickup(undefined) }}
                className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-muted/70 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Pickup: ${pickup.name}. Change pickup`}>
                <span className="size-2.5 shrink-0 rounded-full bg-primary" aria-hidden />
                <span className="min-w-0 flex-1"><span className="block truncate text-[15px] font-medium">{pickup.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{pickup.area}{pickup.id.startsWith('gps') && geo.fix && ` · ±${geo.fix.accuracy} m`}</span></span>
                <span className="text-sm text-primary">Change</span>
              </button>
            ) : (
              <div className="space-y-2">
                <Button variant="outline" className="h-12 w-full justify-start gap-3 rounded-2xl text-[15px]" disabled={geo.status === 'locating'} onClick={useMyLocation}>
                  {geo.status === 'locating' ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <LocateFixed className="size-5 text-primary" aria-hidden />}
                  {geo.status === 'locating' ? 'Finding your location…' : 'Use my current location'}
                </Button>
                <p className="px-1 text-xs text-muted-foreground" aria-live="polite">
                  {GEO_MESSAGE[geo.status] || 'Used once to set your pickup. Captains only see pickup details after you book.'}
                </p>
              </div>
            )}
            {pickup?.id.startsWith('gps') && geo.fix && (geo.fix.accuracy > GOOD_ACCURACY_M || Date.now() - geo.fix.at > STALE_MS) && (
              <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning">
                {geo.fix.accuracy > GOOD_ACCURACY_M ? `Low accuracy (±${geo.fix.accuracy} m). Check the pin, or tap the map to correct it.` : 'This location fix is a few minutes old. Tap Change to refresh it.'}
              </p>
            )}
            {pickup && availability.data && (
              <p className="flex items-center gap-1.5 px-1 text-sm text-muted-foreground">
                <Users className="size-4" aria-hidden />
                {availability.data.categories.reduce((s, x) => s + x.count, 0)} captains within {km(availability.data.radius_m)} (approximate)
              </p>
            )}

            <PlaceSearch key={field} label={field === 'pickup' ? 'Search a pickup landmark' : 'Search a destination'} recents={recents} onPick={pick} autoFocus={!phone && !!pickup} />
          </div>
        )}
      </MapShell>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side={phone ? 'bottom' : 'right'} className={cn(phone && 'max-h-[85dvh] rounded-t-3xl pb-[env(safe-area-inset-bottom)]')}>
          <SheetHeader>
            <SheetTitle>Your rides</SheetTitle>
            <SheetDescription>Last 30 trips with their fare breakdown.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
            {!rides.data?.length ? <Empty>No rides yet. Completed and cancelled trips appear here.</Empty> : rides.data.map((r) => (
              <details key={r.id} className="group rounded-xl bg-muted/50 px-3 open:bg-muted/70">
                <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.drop_label}</span>
                    <span className="block truncate text-xs text-muted-foreground">from {r.pickup_label} · {new Date(r.requested_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-semibold tabular-nums">{inr(r.fare.total)}</span>
                    <StatusChip status={r.status} short />
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
                </summary>
                <div className="pb-3"><FareBreakdown fare={r.fare} /></div>
              </details>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function Tracker({ ride, captain, captainName }: { ride: Ride; captain?: Captain; captainName?: string }) {
  const live = ACTIVE.includes(ride.status)
  const eta = ride.est_pickup_min != null && ['accepted', 'arriving'].includes(ride.status) ? Math.ceil(ride.est_pickup_min) : null
  const age = captain?.location_updated_at ? Math.round((Date.now() - new Date(captain.location_updated_at).getTime()) / 1000) : null
  return (
    <div className="space-y-4 pt-1">
      <div className="flex items-start justify-between gap-3" aria-live="polite">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{statusText(ride.status)}</h1>
          <p className="text-sm text-muted-foreground">
            {ride.status === 'requested' || ride.status === 'offered' ? 'Ranking nearby captains by ETA, workload, reliability and idle time'
              : ride.status === 'ongoing' ? `Heading to ${ride.drop_label}`
              : ride.status === 'completed' ? `Arrived at ${ride.drop_label}` : ride.status === 'cancelled' ? 'This ride was cancelled'
              : ride.status === 'no_driver_found' ? `No captain accepted after ${ride.attempt_no} attempts` : `Meet at ${ride.pickup_label}`}
          </p>
        </div>
        {eta != null && <div className="shrink-0 text-right"><div className="text-2xl leading-none font-semibold tabular-nums">{eta}<span className="text-sm font-medium"> min</span></div><div className="mt-1 text-xs text-muted-foreground">to pickup, est.</div></div>}
        {(ride.status === 'requested' || ride.status === 'offered') && <Loader2 className="mt-1 size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />}
      </div>

      {ride.status !== 'cancelled' && ride.status !== 'no_driver_found' && <StatusStepper status={ride.status} />}

      {ride.attempt_no > 1 && live && (
        <p className="flex items-start gap-2 rounded-xl bg-info-soft px-3 py-2.5 text-sm text-info">
          <RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Reassigned automatically (attempt {ride.attempt_no}). The previous captain declined or didn't respond.</span>
        </p>
      )}
      {ride.status === 'no_driver_found' && (
        <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-destructive">Try another ride type, a wider search, or try again in a moment.</p>
      )}

      {captain && captainName && (
        <div className="space-y-2 rounded-2xl bg-muted/60 p-3">
          <div className="flex items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-full bg-background text-base font-semibold ring-1 ring-foreground/10" aria-hidden>
              {captainName.replace('Captain ', '')[0]}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{captainName}</div>
              <div className="truncate text-sm text-muted-foreground">{captain.vehicle_label}</div>
            </div>
            <span className="shrink-0 rounded-md border-2 border-foreground/80 bg-background px-1.5 py-0.5 font-mono text-xs font-semibold tracking-wider" aria-label={`Number plate ${captain.plate}`}>{captain.plate}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {captain.location_source === 'simulated' ? 'Live position: simulated captain' : age == null ? 'Live position unavailable'
              : `Live position ${captain.location_source === 'gps' ? 'from GPS' : '(manual pin)'} · updated ${age < 60 ? `${age}s` : `${Math.round(age / 60)} min`} ago`}
          </p>
        </div>
      )}
      {!captain && captainName && ['completed'].includes(ride.status) && <p className="text-sm text-muted-foreground">Driven by {captainName}</p>}

      <ol className="relative space-y-3 pl-6 text-sm" aria-label="Route">
        <span className="absolute top-2 bottom-2 left-[4px] w-px bg-foreground/20" aria-hidden />
        <li className="relative"><span className="absolute top-1.5 -left-6 size-2.5 rounded-full bg-primary" aria-hidden /><span className="text-xs text-muted-foreground">Pickup</span><div>{ride.pickup_label}</div></li>
        <li className="relative"><span className="absolute top-1.5 -left-6 size-2.5 rounded-[3px] bg-foreground" aria-hidden /><span className="text-xs text-muted-foreground">Drop</span><div>{ride.drop_label}</div></li>
      </ol>

      <details className="group rounded-xl bg-muted/50 px-3" open={!live}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 rounded-xl text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="font-medium">Fare · {CAT_LABEL[ride.category]}</span>
          <span className="flex items-center gap-1 font-semibold tabular-nums">{inr(ride.fare.total)}<ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden /></span>
        </summary>
        <div className="pb-3"><FareBreakdown fare={ride.fare} /></div>
      </details>
    </div>
  )
}

const KEY = 'up.dismissed'
function dismissed(id: string) { try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]).includes(id) } catch { return false } }
function dismiss(id: string) { try { localStorage.setItem(KEY, JSON.stringify([id])) } catch { /* private mode */ } }
