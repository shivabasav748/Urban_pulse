import { useState } from 'react'
import { Navigate } from 'react-router'
import { z } from 'zod'
import { supabase } from '@/lib/supabase'
import { homeFor, useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Car, ChevronRight, Loader2, MonitorCog, UserRound } from 'lucide-react'

const DEMO = [
  { email: 'rider@demo.up', label: 'Rider', note: 'Book and track a ride', icon: UserRound },
  { email: 'captain1@demo.up', label: 'Captain', note: 'Accept offers, run the trip', icon: Car },
  { email: 'admin@demo.up', label: 'Judge', note: 'Console, Chaos Mode, Arena', icon: MonitorCog },
]
const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name'), email: z.email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'), role: z.enum(['rider', 'driver']), category: z.enum(['bike', 'auto', 'cab']),
})

export default function LoginPage() {
  const { session, profile, loading } = useAuth()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'rider', category: 'bike' })
  if (!loading && session && profile) return <Navigate to={homeFor(profile.role)} replace />

  const signIn = async (email: string, password: string) => {
    setBusy(true); setErr(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setErr(error.message)
    setBusy(false)
  }
  const signUp = async () => {
    const parsed = signupSchema.safeParse(form)
    if (!parsed.success) { setErr(parsed.error.issues[0].message); return }
    setBusy(true); setErr(null)
    const { name, email, password, role, category } = parsed.data
    const { error } = await supabase.auth.signUp({ email, password, options: { data: { name, role, category } } })
    if (error) setErr(error.message)
    setBusy(false)
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value })

  return (
    <main className="flex min-h-dvh justify-center bg-surface px-4 pt-[calc(env(safe-area-inset-top)+40px)] pb-8 sm:items-center sm:pt-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2">
          <span className="grid size-11 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground" aria-hidden>UP</span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Urban Pulse</h1>
            <p className="text-sm text-muted-foreground">Intelligent ride matching · Belagavi demo</p>
          </div>
        </div>
        <Card>
          <Tabs defaultValue="in">
            <CardHeader>
              <TabsList className="grid w-full grid-cols-2"><TabsTrigger value="in">Sign in</TabsTrigger><TabsTrigger value="up">Create account</TabsTrigger></TabsList>
            </CardHeader>
            <CardContent>
              {err && <Alert variant="destructive" className="mb-3"><AlertDescription>{err}</AlertDescription></Alert>}
              <TabsContent value="in">
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); signIn(form.email, form.password) }}>
                  <div className="space-y-1.5"><Label htmlFor="email">Email</Label><Input className="h-11" id="email" type="email" autoComplete="email" value={form.email} onChange={set('email')} required /></div>
                  <div className="space-y-1.5"><Label htmlFor="pw">Password</Label><Input className="h-11" id="pw" type="password" autoComplete="current-password" value={form.password} onChange={set('password')} required /></div>
                  <Button className="h-11 w-full" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}Sign in</Button>
                </form>
              </TabsContent>
              <TabsContent value="up">
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); signUp() }}>
                  <div className="space-y-1.5"><Label htmlFor="name">Name</Label><Input className="h-11" id="name" value={form.name} onChange={set('name')} /></div>
                  <div className="space-y-1.5"><Label htmlFor="em2">Email</Label><Input className="h-11" id="em2" type="email" value={form.email} onChange={set('email')} /></div>
                  <div className="space-y-1.5"><Label htmlFor="pw2">Password</Label><Input className="h-11" id="pw2" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} /></div>
                  <fieldset className="space-y-1.5">
                    <legend className="text-sm font-medium">I want to</legend>
                    <div className="grid grid-cols-2 gap-2">
                      {(['rider', 'driver'] as const).map((r) => (
                        <label key={r} className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                          <input type="radio" name="role" value={r} checked={form.role === r} onChange={set('role')} className="accent-[var(--primary)]" />
                          {r === 'rider' ? 'Ride' : 'Drive (Captain)'}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {form.role === 'driver' && (
                    <div className="space-y-1.5"><Label htmlFor="cat">Vehicle</Label>
                      <select id="cat" value={form.category} onChange={set('category')} className="h-11 w-full rounded-md border bg-background px-2 text-sm">
                        <option value="bike">Bike</option><option value="auto">Auto</option><option value="cab">Cab</option>
                      </select>
                    </div>
                  )}
                  <Button className="h-11 w-full" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}Create account</Button>
                </form>
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>
        {import.meta.env.DEV && (
          <section aria-labelledby="demo-title" className="space-y-2">
            <div className="flex items-baseline justify-between px-1">
              <h2 id="demo-title" className="text-sm font-medium">Try a demo account</h2>
              <span className="text-xs text-muted-foreground">local only</span>
            </div>
            <div className="divide-y overflow-hidden rounded-xl bg-background ring-1 ring-foreground/10">
              {DEMO.map((d) => (
                <button key={d.email} type="button" aria-label={d.label} disabled={busy} onClick={() => signIn(d.email, 'demo1234')}
                  className="flex min-h-14 w-full items-center gap-3 px-3 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-50">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted" aria-hidden><d.icon className="size-4" /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{d.label}</span><span className="block text-xs text-muted-foreground">{d.note}</span></span>
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                </button>
              ))}
            </div>
            <p className="px-1 text-xs text-muted-foreground">Seeded users, password <code>demo1234</code>. All captains and demand are simulated.</p>
          </section>
        )}
      </div>
    </main>
  )
}
