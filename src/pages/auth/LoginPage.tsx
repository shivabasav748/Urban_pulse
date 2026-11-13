import { useState } from 'react'
import { Navigate } from 'react-router'
import { z } from 'zod'
import { supabase } from '@/lib/supabase'
import { homeFor, useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2 } from 'lucide-react'

const DEMO = [
  { email: 'rider@demo.up', label: 'Rider' }, { email: 'captain1@demo.up', label: 'Captain' }, { email: 'admin@demo.up', label: 'Judge' },
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
    <main className="grid min-h-dvh place-items-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground" aria-hidden>UP</span>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Urban Pulse</h1>
            <p className="text-sm text-muted-foreground">Intelligent ride matching · Bengaluru demo</p>
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
                  <div className="space-y-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" autoComplete="email" value={form.email} onChange={set('email')} required /></div>
                  <div className="space-y-1.5"><Label htmlFor="pw">Password</Label><Input id="pw" type="password" autoComplete="current-password" value={form.password} onChange={set('password')} required /></div>
                  <Button className="w-full" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}Sign in</Button>
                </form>
              </TabsContent>
              <TabsContent value="up">
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); signUp() }}>
                  <div className="space-y-1.5"><Label htmlFor="name">Name</Label><Input id="name" value={form.name} onChange={set('name')} /></div>
                  <div className="space-y-1.5"><Label htmlFor="em2">Email</Label><Input id="em2" type="email" value={form.email} onChange={set('email')} /></div>
                  <div className="space-y-1.5"><Label htmlFor="pw2">Password</Label><Input id="pw2" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} /></div>
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
                      <select id="cat" value={form.category} onChange={set('category')} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                        <option value="bike">Bike</option><option value="auto">Auto</option><option value="cab">Cab</option>
                      </select>
                    </div>
                  )}
                  <Button className="w-full" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}Create account</Button>
                </form>
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>
        {import.meta.env.DEV && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Demo accounts (local only)</CardTitle>
              <CardDescription>Seeded users, password <code>demo1234</code></CardDescription></CardHeader>
            <CardContent className="grid grid-cols-3 gap-2">
              {DEMO.map((d) => <Button key={d.email} variant="outline" size="sm" disabled={busy} onClick={() => signIn(d.email, 'demo1234')}>{d.label}</Button>)}
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  )
}
