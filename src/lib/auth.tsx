import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type Role = 'rider' | 'driver' | 'admin'
type Profile = { id: string; role: Role; display_name: string }
type Auth = { session: Session | null; profile: Profile | null; loading: boolean; signOut: () => Promise<void> }

const Ctx = createContext<Auth>({ session: null, profile: null, loading: true, signOut: async () => {} })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) { setProfile(null); setLoading(false); return }
    setLoading(true)
    supabase.from('profiles').select('id, role, display_name').eq('id', session.user.id).single()
      .then(({ data }) => { setProfile(data as Profile | null); setLoading(false) })
  }, [session])

  return (
    <Ctx.Provider value={{ session, profile, loading, signOut: async () => { await supabase.auth.signOut() } }}>
      {children}
    </Ctx.Provider>
  )
}

export const useAuth = () => useContext(Ctx)
export const homeFor = (role?: Role) => (role === 'driver' ? '/driver' : role === 'admin' ? '/judge' : '/rider')
