import { Badge } from '@/components/ui/badge'
import { Bike, Car, CarTaxiFront, Check, FlaskConical, LogOut } from 'lucide-react'
import type { Ride, RideStatus } from '@/lib/supabase'
import { inr } from '@/lib/geo'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Link } from 'react-router'

export const CAT_ICON = { bike: Bike, auto: CarTaxiFront, cab: Car } as const
export const CAT_LABEL = { bike: 'Bike', auto: 'Auto', cab: 'Cab' } as const

export function SimBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1 border-amber-300 bg-amber-50 text-amber-800', className)}>
      <FlaskConical className="size-3" aria-hidden /> SIMULATED
    </Badge>
  )
}

const STATUS_TEXT: Record<RideStatus, string> = {
  requested: 'Finding a driver', offered: 'Waiting for driver to accept', accepted: 'Driver assigned',
  arriving: 'Driver on the way', ongoing: 'On trip', completed: 'Completed', cancelled: 'Cancelled',
  no_driver_found: 'No driver found',
}
const STATUS_TONE: Record<RideStatus, string> = {
  requested: 'bg-sky-50 text-sky-800 border-sky-200', offered: 'bg-sky-50 text-sky-800 border-sky-200',
  accepted: 'bg-teal-50 text-teal-800 border-teal-200', arriving: 'bg-teal-50 text-teal-800 border-teal-200',
  ongoing: 'bg-indigo-50 text-indigo-800 border-indigo-200', completed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  cancelled: 'bg-zinc-100 text-zinc-700 border-zinc-200', no_driver_found: 'bg-red-50 text-red-800 border-red-200',
}
export const statusText = (s: RideStatus) => STATUS_TEXT[s]

export function StatusChip({ status }: { status: RideStatus }) {
  return <Badge variant="outline" className={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>
}

const STEPS: { key: RideStatus; label: string }[] = [
  { key: 'requested', label: 'Requested' }, { key: 'accepted', label: 'Accepted' },
  { key: 'arriving', label: 'Arriving' }, { key: 'ongoing', label: 'Ongoing' }, { key: 'completed', label: 'Completed' },
]
const ORDER: Record<string, number> = { requested: 0, offered: 0, accepted: 1, arriving: 2, ongoing: 3, completed: 4 }

export function StatusStepper({ status }: { status: RideStatus }) {
  const at = ORDER[status] ?? -1
  return (
    <ol className="flex items-center gap-1" aria-label={`Ride status: ${STATUS_TEXT[status]}`}>
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex flex-1 flex-col items-center gap-1">
          <span className={cn('grid size-6 place-items-center rounded-full border text-[11px] font-semibold',
            i < at ? 'border-primary bg-primary text-primary-foreground' : i === at ? 'border-primary text-primary ring-2 ring-primary/20' : 'border-border text-muted-foreground')}>
            {i < at ? <Check className="size-3.5" aria-hidden /> : i + 1}
          </span>
          <span className={cn('text-[11px]', i <= at ? 'text-foreground' : 'text-muted-foreground')}>{s.label}</span>
        </li>
      ))}
    </ol>
  )
}

export function FareBreakdown({ fare }: { fare: Ride['fare'] }) {
  const rows: [string, number][] = [['Base fare', fare.base], ['Distance', fare.distance], ['Time', fare.time]]
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      {rows.flatMap(([k, v]) => [
        <dt className="text-muted-foreground" key={k}>{k}</dt>,
        <dd className="text-right tabular-nums" key={k + 'v'}>{inr(v)}</dd>,
      ])}
      <dt className="text-muted-foreground">Surge (simulated)</dt><dd className="text-right tabular-nums">×{Number(fare.surge_mult).toFixed(2)}</dd>
      {fare.pool_discount ? (<><dt className="text-muted-foreground">Pool discount</dt><dd className="text-right tabular-nums">−{fare.pool_discount * 100}%</dd></>) : null}
      <dt className="border-t pt-1 font-medium">Estimated total</dt><dd className="border-t pt-1 text-right font-semibold tabular-nums">{inr(fare.total)}</dd>
    </dl>
  )
}

export function AppHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  const { profile, signOut } = useAuth()
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4">
      <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
        <span className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground" aria-hidden>UP</span>
        Urban Pulse
      </Link>
      <span className="hidden text-sm text-muted-foreground sm:inline">/ {title}</span>
      <div className="ml-auto flex items-center gap-2">
        {children}
        {profile && <span className="hidden text-sm text-muted-foreground md:inline">{profile.display_name}</span>}
        <Button variant="ghost" size="sm" onClick={signOut} aria-label="Sign out"><LogOut className="size-4" aria-hidden /></Button>
      </div>
    </header>
  )
}
