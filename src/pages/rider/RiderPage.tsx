import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowDownUp, ChevronRight, History, Loader2, MapPin, RefreshCw, TrendingUp, Users } from 'lucide-react'
import { MapCanvas, type MapPin as Pin } from '@/components/map/MapCanvas'
import { MapShell } from '@/components/layout/MapShell'
import { Brand, CAT_ICON, CAT_LABEL, Empty, FareBreakdown, LoadError, SignOutButton, SimBadge, StatusChip, StatusStepper, statusText } from '@/components/ride/bits'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/lib/auth'
import { useLive, usePhone, useSweep } from '@/lib/hooks'
import { PLACES, type Place } from '@/lib/places'
import { rpc, supabase, type Ride } from '@/lib/supabase'
import { inr } from '@/lib/geo'
import { cn } from '@/lib/utils'

type Estimate = {
  distance_km: number; surge: number; zone?: { name: string; forecast: number; supply: number; raw: number; smoothed: number }
  categories: { category: 'bike' | 'auto' | 'cab'; trip_min: number; fare: Ride['fare']; drivers: number; pickup_eta_min: number | null }[]
}
type Captain = { user_id: string; lat: number; lng: number; vehicle_category: string; vehicle_label: string; plate: string; profiles: { display_name: string } }
const ACTIVE = ['requested', 'offered', 'accepted', 'arriving', 'ongoing']

/** Pickup and destination as one connected control: dots joined by a line, swap on the right. */
function RouteInputs({ pickup, drop, setPickup, setDrop }: { pickup?: Place; drop?: Place; setPickup: (p?: Place) => void; setDrop: (p?: Place) => void }) {
  const field = (id: string, label: string, value: Place | undefined, set: (p: Place) => void, exclude?: string) => (
    <div className="flex min-h-12 items-center">
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} value={value?.id ?? ''} onChange={(e) => { const p = PLACES.find((x) => x.id === e.target.value); if (p) set(p) }}
        className={cn('h-12 w-full min-w-0 appearance-none truncate bg-transparent pr-2 text-[15px] outline-none', !value && 'text-muted-foreground')}>
        <option value="" disabled>{label}</option>
        {PLACES.filter((p) => p.id !== exclude).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.area}</option>)}
      </select>
    </div>
  )
  return (
    <div className="flex items-stretch gap-3 rounded-2xl bg-muted/70 pr-2 pl-4 has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-ring">
      <div className="flex flex-col items-center py-[22px]" aria-hidden>
        <span className="size-2.5 rounded-full bg-primary" /><span className="w-px flex-1 bg-foreground/25" /><span className="size-2.5 rounded-[3px] bg-foreground" />
      </div>
      <div className="min-w-0 flex-1 divide-y divide-foreground/10">
        {field('pickup', 'Pickup location', pickup, setPickup, drop?.id)}
        {field('drop', 'Where to?', drop, setDrop, pickup?.id)}
      </div>
      <Button type="button" variant="ghost" size="icon" className="self-center rounded-full" aria-label="Swap pickup and destination"
        onClick={() => { setPickup(drop); setDrop(pickup) }} disabled={!pickup && !drop}>
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
  const [pickup, setPickup] = useState<Place>()
  const [drop, setDrop] = useState<Place>()
  const [cat, setCat] = useState<'bike' | 'auto' | 'cab'>('bike')
  const [historyOpen, setHistoryOpen] = useState(false)
  useSweep()
  useLive('rides', [['rides', uid]], `rider_id=eq.${uid}`)
  useLive('driver_profiles', [['drivers']])

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

  const drivers = useQuery({
    queryKey: ['drivers'],
    queryFn: async () => {
      const { data, error } = await supabase.from('driver_profiles').select('user_id, lat, lng, vehicle_category, online, vehicle_label, plate, profiles(display_name)').eq('online', true)
      if (error) throw error
      return data as unknown as Captain[]
    },
  })

  const estimate = useQuery({
    queryKey: ['estimate', pickup?.id, drop?.id],
    enabled: !!pickup && !!drop && !active,
    queryFn: () => rpc<Estimate>('estimate_ride', { p_lat: pickup!.lat, p_lng: pickup!.lng, d_lat: drop!.lat, d_lng: drop!.lng }),
  })
  // keep the selection valid: if the chosen type has no captains nearby, fall back to the first one that does
  const chosen = estimate.data?.categories.find((c) => c.category === cat && c.drivers > 0) ?? estimate.data?.categories.find((c) => c.drivers > 0)

  const request = useMutation({
    mutationFn: () => rpc('request_ride', { p_pickup_label: pickup!.name, p_lat: pickup!.lat, p_lng: pickup!.lng, p_drop_label: drop!.name, d_lat: drop!.lat, d_lng: drop!.lng, p_category: chosen!.category }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rides', uid] }),
    onError: (e) => toast.error(e.message),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => rpc('cancel_ride', { p_ride: id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rides', uid] }); toast('Ride cancelled') },
    onError: (e) => toast.error(e.message),
  })

  const assigned = drivers.data?.find((d) => d.user_id === showTracker?.driver_id)
  const pins: Pin[] = showTracker
    ? [{ lat: showTracker.pickup_lat, lng: showTracker.pickup_lng, kind: 'pickup', label: `Pickup: ${showTracker.pickup_label}` },
       { lat: showTracker.drop_lat, lng: showTracker.drop_lng, kind: 'drop', label: `Drop: ${showTracker.drop_label}` }]
    : [pickup && { ...pickup, kind: 'pickup' as const, label: `Pickup: ${pickup.name}` }, drop && { ...drop, kind: 'drop' as const, label: `Drop: ${drop.name}` }].filter(Boolean) as Pin[]
  const route = pins.length === 2 ? pins.map((p) => [p.lat, p.lng] as [number, number]) : undefined
  const mapDrivers = useMemo(() => (drivers.data ?? []).map((d) => ({
    id: d.user_id, lat: d.lat, lng: d.lng, label: d.profiles?.display_name ?? 'Captain', category: d.vehicle_category,
    highlight: d.user_id === showTracker?.driver_id,
  })), [drivers.data, showTracker?.driver_id])
  const fit = assigned && showTracker && ['accepted', 'arriving'].includes(showTracker.status)
    ? [[assigned.lat, assigned.lng], [showTracker.pickup_lat, showTracker.pickup_lng]] as [number, number][]
    : route ?? (pickup ? [[pickup.lat, pickup.lng] as [number, number]] : undefined)
  const finished = showTracker && !ACTIVE.includes(showTracker.status)

  const footer = rides.isLoading || rides.error ? undefined : showTracker ? (
    finished
      ? <Button className="h-12 w-full text-[15px]" onClick={() => { dismiss(showTracker.id); qc.invalidateQueries({ queryKey: ['rides', uid] }) }}>Book another ride</Button>
      : ['requested', 'offered', 'accepted', 'arriving'].includes(showTracker.status)
        ? <Button variant="outline" className="h-12 w-full text-[15px]" onClick={() => cancel.mutate(showTracker.id)} disabled={cancel.isPending}>
            {cancel.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}Cancel ride</Button>
        : undefined
  ) : (
    <Button className="h-12 w-full justify-between px-5 text-[15px]" disabled={!chosen || request.isPending} onClick={() => request.mutate()}>
      <span className="flex items-center gap-2">{request.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {chosen ? `Request ${CAT_LABEL[chosen.category]}` : pickup && drop ? (estimate.isLoading ? 'Getting prices…' : 'No captains nearby') : 'Choose where to go'}</span>
      {chosen && <span className="tabular-nums">{inr(chosen.fare.total)}</span>}
    </Button>
  )

  return (
    <>
      <MapShell label={showTracker ? 'Your ride' : 'Book a ride'} footer={footer}
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
            const near = PLACES.reduce((a, b) => (Math.hypot(a.lat - lat, a.lng - lng) < Math.hypot(b.lat - lat, b.lng - lng) ? a : b))
            if (!pickup) setPickup(near); else if (!drop && near.id !== pickup.id) setDrop(near)
          }} />}>
        {rides.isLoading ? (
          <div className="space-y-3 pt-1"><Skeleton className="h-6 w-40" /><Skeleton className="h-24 w-full rounded-2xl" /><Skeleton className="h-16 w-full" /></div>
        ) : rides.error ? (
          <LoadError what="your rides" error={rides.error} retry={() => rides.refetch()} />
        ) : showTracker ? (
          <Tracker ride={showTracker} captain={assigned} />
        ) : (
          <div className="space-y-4">
            <h1 className="pt-1 text-xl font-semibold tracking-tight">Where to?</h1>
            <RouteInputs pickup={pickup} drop={drop} setPickup={setPickup} setDrop={setDrop} />
            {!pickup || !drop ? (
              <Empty icon={<MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />}>
                Pick a pickup and destination, or tap the map near a place. Demo places only, in Bengaluru.
              </Empty>
            ) : estimate.isLoading ? (
              <div className="space-y-2" aria-busy="true" aria-label="Loading prices">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[68px] w-full rounded-xl" />)}</div>
            ) : estimate.error ? (
              <LoadError what="prices" error={estimate.error} retry={() => estimate.refetch()} />
            ) : estimate.data && (
              <div className="space-y-3">
                <div role="radiogroup" aria-label="Ride type" className="space-y-1.5">
                  {estimate.data.categories.map((c) => {
                    const Icon = CAT_ICON[c.category], none = c.drivers === 0, on = chosen?.category === c.category
                    return (
                      <button key={c.category} role="radio" aria-checked={on} disabled={none} onClick={() => setCat(c.category)}
                        className={cn('flex min-h-[68px] w-full items-center gap-3 rounded-xl px-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45',
                          on ? 'bg-primary/8 ring-2 ring-primary' : 'hover:bg-muted')}>
                        <span className={cn('grid size-11 shrink-0 place-items-center rounded-xl', on ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>
                          <Icon className="size-5" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="font-medium">{CAT_LABEL[c.category]}</span>
                            {!none && <span className="text-sm text-muted-foreground tabular-nums">{Math.ceil(c.pickup_eta_min ?? 0)} min away</span>}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            {none ? 'No captains nearby right now' : <><Users className="size-3" aria-hidden />{c.drivers} nearby · {Math.round(c.trip_min)} min trip</>}
                          </span>
                        </span>
                        <span className="text-right text-base font-semibold tabular-nums">{inr(c.fare.total)}</span>
                      </button>
                    )
                  })}
                </div>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="tabular-nums">{Number(estimate.data.distance_km).toFixed(1)} km, estimated</span>
                  {estimate.data.surge > 1 && estimate.data.zone && (
                    <span className="inline-flex items-center gap-1 font-medium text-warning">
                      <TrendingUp className="size-3" aria-hidden />×{estimate.data.surge.toFixed(2)} surge: {Number(estimate.data.zone.forecast).toFixed(1)} rides forecast vs {estimate.data.zone.supply} free captains in {estimate.data.zone.name}
                    </span>
                  )}
                </p>
              </div>
            )}
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

function Tracker({ ride, captain }: { ride: Ride; captain?: Captain }) {
  const live = ACTIVE.includes(ride.status)
  const showCaptain = captain && ['accepted', 'arriving', 'ongoing', 'completed'].includes(ride.status)
  const eta = ride.est_pickup_min != null && ['accepted', 'arriving'].includes(ride.status) ? Math.ceil(ride.est_pickup_min) : null
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
        <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-destructive">Try another ride type, or try again in a moment.</p>
      )}

      {showCaptain && (
        <div className="flex items-center gap-3 rounded-2xl bg-muted/60 p-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-full bg-background text-base font-semibold ring-1 ring-foreground/10" aria-hidden>
            {captain.profiles.display_name.replace('Captain ', '')[0]}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{captain.profiles.display_name}</div>
            <div className="truncate text-sm text-muted-foreground">{captain.vehicle_label}</div>
          </div>
          <span className="shrink-0 rounded-md border-2 border-foreground/80 bg-background px-1.5 py-0.5 font-mono text-xs font-semibold tracking-wider" aria-label={`Number plate ${captain.plate}`}>{captain.plate}</span>
        </div>
      )}

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
