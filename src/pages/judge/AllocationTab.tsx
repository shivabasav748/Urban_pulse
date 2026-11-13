import { useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DEFAULT_WEIGHTS, ZONE_WEIGHT, scoreDrivers, type Policy, type Weights } from '@/lib/allocation'
import { Tag } from '@/components/ride/bits'
import { cn } from '@/lib/utils'
import { routeLabel, useAudit, useGroups, useOffers, type RankRow } from './data'

const COMP = [
  { k: 'c_eta', w: 'eta', label: 'Pickup ETA', dir: 'closer = higher' },
  { k: 'c_workload', w: 'workload', label: 'Workload', dir: 'fewer trips today = higher' },
  { k: 'c_reliability', w: 'reliability', label: 'Reliability', dir: 'acceptance (prior 0.8)' },
  { k: 'c_idle', w: 'idle', label: 'Idle time', dir: 'waited longer = higher' },
  { k: 'c_zone', w: 'zone', label: 'Zone balance', dir: 'from a zone with spare captains = higher' },
] as const
const REASON: Record<string, string> = {
  eligible: 'Eligible', offline: 'Offline', location_stale_or_inaccurate: 'Location stale or inaccurate', vehicle_category_mismatch: 'Different vehicle type',
  outside_search_radius: 'Outside search radius', on_active_trip: 'On a trip', already_offered_this_ride: 'Already offered this ride',
  holding_another_offer: 'Holding another offer', not_opted_in_for_women_driver_preference: 'Not opted in (women-driver preference)',
}

export default function AllocationTab() {
  const groups = useGroups()
  const withOffers = groups.data?.filter((g) => g.attempt_no > 0) ?? []
  const [gid, setGid] = useState<string>()
  const sel = gid ?? withOffers[0]?.id
  const offers = useOffers(sel)
  const [attempt, setAttempt] = useState<number>()
  const offer = offers.data?.find((o) => o.attempt_no === (attempt ?? offers.data?.[0]?.attempt_no))
  const audit = useAudit(sel)
  const [w, setW] = useState<Weights & { zone: number }>({ ...DEFAULT_WEIGHTS, zone: ZONE_WEIGHT })
  const DEF = { ...DEFAULT_WEIGHTS, zone: ZONE_WEIGHT }
  const [over, setOver] = useState<Record<string, { trips?: number; idle?: number }>>({})

  const row = audit.data?.find((a) => a.offer_id === offer?.id)
  const snapshot: RankRow[] = useMemo(() => row?.ranking ?? [], [row])
  const policy = (offer?.components.policy ?? 'urban_pulse') as Policy
  const rescored = useMemo(() => scoreDrivers(snapshot.map((r) => ({
    id: r.driver_id, pickupMin: Number(r.pickup_min), tripsToday: over[r.driver_id]?.trips ?? r.trips_today,
    idleMin: over[r.driver_id]?.idle ?? Number(r.idle_min), reliability: Number(r.c_reliability), offersAccepted: 0, offersReceived: 0, zoneSlack: Number(r.c_zone ?? 0),
  })), policy, w, w.zone), [snapshot, w, over, policy])
  const nearest = useMemo(() => scoreDrivers(snapshot.map((r) => ({ id: r.driver_id, pickupMin: Number(r.pickup_min), tripsToday: 0, idleMin: 0, offersAccepted: 0, offersReceived: 0 })), 'nearest')[0]?.id, [snapshot])
  const name = (id: string) => snapshot.find((r) => r.driver_id === id)?.name ?? id
  const changed = JSON.stringify(w) !== JSON.stringify(DEF) || Object.keys(over).length > 0
  const comps = COMP.filter((c) => policy === 'zone_aware' || c.k !== 'c_zone')
  const winner = rescored[0], runner = rescored[1]

  if (groups.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!withOffers.length) return <p className="rounded-md bg-background p-4 text-sm text-muted-foreground">No dispatch decisions yet. Request a ride (rider app or Chaos Mode → Create demo ride) and the ranking appears here.</p>

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Dispatch decisions</CardTitle></CardHeader>
        <CardContent className="max-h-[560px] space-y-1 overflow-y-auto">
          {withOffers.map((g) => (
            <button key={g.id} onClick={() => { setGid(g.id); setAttempt(undefined); setOver({}) }}
              className={cn('w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted', sel === g.id && 'bg-primary/10 font-medium')}>
              {routeLabel(g)} <span className="text-xs text-muted-foreground">· {g.attempt_no} attempt{g.attempt_no > 1 ? 's' : ''} · {g.status}</span>
            </button>
          ))}
        </CardContent>
      </Card>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {offers.data?.map((o) => (
            <Button key={o.id} size="sm" variant={o.attempt_no === offer?.attempt_no ? 'default' : 'outline'} onClick={() => setAttempt(o.attempt_no)}>
              Attempt {o.attempt_no}: {o.components.chosen.name} · {o.outcome}
            </Button>
          ))}
        </div>
        {offer && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Why {name(winner?.id ?? offer.driver_id)}?</CardTitle>
              <CardDescription>
                {policy === 'zone_aware' ? <>score = (1 − {w.zone})·({w.eta}·ETA + {w.workload}·workload + {w.reliability}·reliability + {w.idle}·idle) + {w.zone}·zone balance.</> : <>score = {w.eta}·ETA + {w.workload}·workload + {w.reliability}·reliability + {w.idle}·idle.</>} Each component is min-max normalised across eligible captains (0 to 1).
                {nearest && <> Nearest-driver baseline would pick <b>{name(nearest)}</b>.</>}
                {' '}Transparent prototype policy, not a claim of universal fairness.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {changed && <Badge variant="outline" className="h-auto border-info/20 bg-info-soft whitespace-normal text-info">What-if view: re-scored in the browser with your weights/overrides. The stored decision used {JSON.stringify(offer.components.weights)}</Badge>}
              <div className="overflow-x-auto">
                <table className="rtable w-full min-w-[640px] text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 font-medium">Captain</th>{comps.map((c) => <th key={c.k} className="font-medium" title={c.dir}>{c.label}</th>)}<th className="text-right font-medium">Score</th>
                  </tr></thead>
                  <tbody>
                    {rescored.map((r, i) => {
                      const raw = snapshot.find((s) => s.driver_id === r.id)!
                      return (
                        <tr key={r.id} className={cn('border-t', i === 0 && 'bg-primary/5')}>
                          <td className="py-2 pr-2">
                            <div className="font-medium">{i === 0 && '★ '}{raw.name}</div>
                            <div className="text-xs text-muted-foreground">{Number(raw.pickup_min).toFixed(1)} min · {r.tripsToday} trips · idle {Math.round(r.idleMin)}m</div>
                          </td>
                          {comps.map((c) => (
                            <td key={c.k} data-label={c.label} className="pr-2">
                              <div className="flex items-center gap-1.5">
                                <div className="h-2 w-16 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${r[c.k] * 100}%` }} /></div>
                                <span className="text-xs tabular-nums">{r[c.k].toFixed(2)}</span>
                              </div>
                            </td>
                          ))}
                          <td data-label="Score" className="text-right font-semibold tabular-nums">{r.score.toFixed(3)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {winner && runner && (
                <p className="text-sm">
                  <b>{name(winner.id)}</b> beats <b>{name(runner.id)}</b> by {(winner.score - runner.score).toFixed(3)}:
                  {' '}{comps.map((c) => ({ c, d: (w[c.w] * (winner[c.k] - runner[c.k])) })).filter((x) => Math.abs(x.d) > 0.001)
                    .sort((a, b) => b.d - a.d).map((x) => `${x.c.label} ${x.d > 0 ? '+' : ''}${x.d.toFixed(3)}`).join(', ')}.
                </p>
              )}
            </CardContent>
          </Card>
        )}
        {row && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Who was considered, and why others were not</CardTitle>
              <CardDescription>Nearest captains to the pickup at the moment of this decision, with the first rule each one failed. Judge-only: riders and captains never see this.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(row.eligibility.counts ?? {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => <Tag key={k} tone={k === 'eligible' ? 'success' : 'muted'}>{REASON[k] ?? k}: {n}</Tag>)}
              </div>
              <ul className="divide-y text-sm">
                {(row.eligibility.nearest ?? []).map((e) => (
                  <li key={e.driver_id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate">{e.name} <span className="text-xs text-slate-500 num">· {Number(e.km).toFixed(1)} km</span></span>
                    <Tag tone={e.reason === 'eligible' ? 'success' : 'muted'}>{REASON[e.reason] ?? e.reason}</Tag>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
        {offer && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Try it: change weights or a captain's workload / idle time</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3">
                {comps.map((c) => (
                  <div key={c.w} className="space-y-1">
                    <div className="flex justify-between text-sm"><span>{c.label}</span><span className="tabular-nums">{w[c.w].toFixed(2)}</span></div>
                    <Slider aria-label={`${c.label} weight`} min={0} max={1} step={0.05} value={[w[c.w]]} onValueChange={([v]) => setW({ ...w, [c.w]: v })} />
                  </div>
                ))}
              </div>
              <div className="space-y-2 text-sm">
                {snapshot.slice(0, 3).map((r) => (
                  <div key={r.driver_id} className="grid grid-cols-[1fr_80px_80px] items-center gap-2">
                    <span className="truncate">{r.name}</span>
                    <label className="text-xs">trips<input type="number" min={0} className="h-8 w-full rounded border px-1" value={over[r.driver_id]?.trips ?? r.trips_today}
                      onChange={(e) => setOver({ ...over, [r.driver_id]: { ...over[r.driver_id], trips: Number(e.target.value) } })} /></label>
                    <label className="text-xs">idle min<input type="number" min={0} className="h-8 w-full rounded border px-1" value={over[r.driver_id]?.idle ?? Math.round(Number(r.idle_min))}
                      onChange={(e) => setOver({ ...over, [r.driver_id]: { ...over[r.driver_id], idle: Number(e.target.value) } })} /></label>
                  </div>
                ))}
                <Button size="sm" variant="outline" disabled={!changed} onClick={() => { setW(DEF); setOver({}) }}>Reset to stored decision</Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
