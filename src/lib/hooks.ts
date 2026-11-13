import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { rpc, supabase } from './supabase'

/** Subscribe to postgres_changes on a table (RLS-filtered) and invalidate the given query keys. */
export function useLive(table: string, keys: unknown[][], filter?: string) {
  const qc = useQueryClient()
  const sig = JSON.stringify([table, filter, keys])
  useEffect(() => {
    const ch = supabase
      .channel(`live:${sig}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, () => {
        keys.forEach((k) => qc.invalidateQueries({ queryKey: k }))
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
}

/** Server-side timeout/delay detection + fast-demo simulated drivers. Idempotent; clocks checked in SQL. */
export function useSweep(enabled = true, everyMs = 3000) {
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => { rpc('sweep_exceptions').catch(() => {}) }, everyMs)
    return () => clearInterval(t)
  }, [enabled, everyMs])
}
