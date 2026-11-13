import { Badge } from '@/components/ui/badge'
import { useEffect, useState, type ReactNode } from 'react'
import { Bike, Car, CarTaxiFront, Check, CircleAlert, FlaskConical, LogOut, WifiOff } from 'lucide-react'
import type { Ride, RideStatus } from '@/lib/supabase'
import { inr } from '@/lib/geo'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Link } from 'react-router'

export const CAT_ICON = { bike: Bike, auto: CarTaxiFront, cab: Car } as const
export const CAT_LABEL = { bike: 'Bike', auto: 'Auto', cab: 'Cab' } as const

export function SimBadge({ className, label = 'Simulated' }: { className?: string; label?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1 border-warning/25 bg-warning-soft font-medium text-warning', className)}
      title="Captains, demand, weather, routes and surge are simulated for this prototype">
      <FlaskConical className="size-3" aria-hidden /> {label}
    </Badge>
  )
}

const STATUS_TEXT: Record<RideStatus, string> = {
  requested: 'Finding a captain', offered: 'Waiting for captain to accept', accepted: 'Captain assigned',
  arriving: 'Captain on the way', ongoing: 'On trip', completed: 'Trip completed', cancelled: 'Cancelled',
  no_driver_found: 'No captain found',
}
export const STATUS_SHORT: Record<RideStatus, string> = {
  requested: 'Matching', offered: 'Offered', accepted: 'Assigned', arriving: 'Arriving', ongoing: 'On trip',
  completed: 'Completed', cancelled: 'Cancelled', no_driver_found: 'No captain',
}
const TONE = {
  info: 'border-info/20 bg-info-soft text-info', brand: 'border-primary/20 bg-primary/8 text-primary',
  success: 'border-success/20 bg-success-soft text-success', muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/20 bg-danger-soft text-destructive',
}
const STATUS_TONE: Record<RideStatus, keyof typeof TONE> = {
  requested: 'info', offered: 'info', accepted: 'brand', arriving: 'brand', ongoing: 'brand',
  completed: 'success', cancelled: 'muted', no_driver_found: 'danger',
}
export const statusText = (s: RideStatus) => STATUS_TEXT[s]

export function StatusChip({ status, short }: { status: RideStatus; short?: boolean }) {
  return <Badge variant="outline" className={TONE[STATUS_TONE[status]]}>{short ? STATUS_SHORT[status] : STATUS_TEXT[status]}</Badge>
}

const STEPS: { key: RideStatus; label: string }[] = [
  { key: 'requested', label: 'Requested' }, { key: 'accepted', label: 'Assigned' },
  { key: 'arriving', label: 'Arriving' }, { key: 'ongoing', label: 'On trip' }, { key: 'completed', label: 'Done' },
]
const ORDER: Record<string, number> = { requested: 0, offered: 0, accepted: 1, arriving: 2, ongoing: 3, completed: 4 }

/** Progress line rather than numbered circles: reads at a glance, no text to parse. */
export function StatusStepper({ status }: { status: RideStatus }) {
  const at = ORDER[status] ?? -1
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label={`Ride status: ${STATUS_TEXT[status]}`}>
      {STEPS.map((s, i) => (
        <li key={s.key} aria-current={i === at ? 'step' : undefined} className="space-y-1.5">
          <span aria-hidden className={cn('block h-1 rounded-full',
            i < at || (i === at && at === 4) ? 'bg-primary' : i === at ? 'bg-primary motion-safe:animate-pulse' : 'bg-border')} />
          <span className={cn('flex items-center gap-1 text-xs', i <= at ? 'text-foreground' : 'text-muted-foreground', i === at && 'font-medium')}>
            {i < at && <Check className="size-3 text-primary" aria-hidden />}{s.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

export function FareBreakdown({ fare }: { fare: Ride['fare'] }) {
  const rows: [string, string][] = [['Base fare', inr(fare.base)], ['Distance', inr(fare.distance)], ['Time', inr(fare.time)]]
  if (Number(fare.surge_mult) !== 1) rows.push(['Surge (simulated)', `×${Number(fare.surge_mult).toFixed(2)}`])
  if (fare.pool_discount) rows.push(['Pool discount', `−${fare.pool_discount * 100}%`])
  return (
    <dl className="space-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4"><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums">{v}</dd></div>
      ))}
      <div className="flex items-baseline justify-between gap-4 border-t pt-2">
        <dt className="font-medium">Estimated total</dt><dd className="text-base font-semibold tabular-nums">{inr(fare.total)}</dd>
      </div>
    </dl>
  )
}

export function Brand({ compact }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="grid size-7 place-items-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground" aria-hidden>UP</span>
      <span className={cn(compact && 'sr-only sm:not-sr-only')}>Urban Pulse</span>
    </Link>
  )
}

export function SignOutButton({ className }: { className?: string }) {
  const { signOut } = useAuth()
  return <Button variant="ghost" size="icon" className={className} onClick={signOut} aria-label="Sign out"><LogOut className="size-4" aria-hidden /></Button>
}

/** Header for the judge console and Arena (desktop-leaning operations screens). */
export function AppHeader({ title, children }: { title: string; children?: ReactNode }) {
  const { profile } = useAuth()
  return (
    <header className="sticky top-0 z-[1000] flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <Brand compact />
      <span className="hidden text-sm text-muted-foreground sm:inline">/ {title}</span>
      <div className="ml-auto flex items-center gap-2">
        {children}
        {profile && <span className="hidden max-w-40 truncate text-sm text-muted-foreground lg:inline">{profile.display_name}</span>}
        <SignOutButton />
      </div>
    </header>
  )
}

/** One empty-state style for the whole app: says what is missing and what to do next. */
export function Empty({ children, className, icon }: { children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-xl bg-muted/60 px-4 py-3.5 text-sm text-muted-foreground', className)}>
      {icon}<div className="min-w-0">{children}</div>
    </div>
  )
}

/** Inline query failure with a way to recover. */
export function LoadError({ what, error, retry }: { what: string; error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error)
  const offline = /fetch|network/i.test(msg)
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-danger-soft px-3 py-2.5 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Couldn't load {what}</div>
        <div className="break-words opacity-90">{offline ? 'The server is unreachable. Check the connection and that the local database is running.' : msg}</div>
      </div>
      {retry && <Button size="sm" variant="outline" className="shrink-0 bg-background" onClick={retry}>Retry</Button>}
    </div>
  )
}

/** Shown app-wide while the browser reports no network. Realtime and polling resume on their own. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  if (online) return null
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-[2000] flex items-center justify-center gap-2 bg-foreground px-3 pt-[calc(env(safe-area-inset-top)+6px)] pb-1.5 text-sm text-background">
      <WifiOff className="size-4" aria-hidden /> You're offline. Ride updates resume when the connection returns.
    </div>
  )
}
