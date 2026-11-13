import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, MessageCircle, Phone, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useLive, usePhone } from '@/lib/hooks'
import { rpc, supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { friendly } from './bits'

type Msg = { id: number; sender: string; body: string; at: string }
const QUICK = { rider: ['I’m at the pickup point', 'Please call me when you arrive', 'I’ll be there in 2 minutes', 'Where are you?'],
  captain: ['I’ve arrived at the pickup', 'On my way, 2 minutes', 'Stuck in traffic, coming soon', 'Where exactly are you?'] }

/** Rider <-> captain chat for one live trip. Messages go through send_ride_message (RLS: only the two parties). */
export function ContactButton({ rideId, me, other, as, live }: { rideId: string; me: string; other: string; as: 'rider' | 'captain'; live: boolean }) {
  const phone = usePhone()
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const key = ['ride-messages', rideId]
  const msgs = useQuery({ queryKey: key, queryFn: async () => ((await supabase.from('ride_messages').select('id, sender, body, at').eq('ride_id', rideId).order('id')).data ?? []) as Msg[] })
  useLive('ride_messages', [key], `ride_id=eq.${rideId}`)
  const send = useMutation({
    mutationFn: (body: string) => rpc('send_ride_message', { p_ride: rideId, p_body: body }),
    onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: key }) },
    onError: (e) => toast.error(friendly(e.message)),
  })
  const unread = (msgs.data ?? []).filter((m) => m.sender !== me).length
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" className="relative" onClick={() => setOpen(true)}>
          <MessageCircle className="size-4" aria-hidden />Message
          {unread > 0 && <span className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-rose-600 text-[10px] font-bold text-white" aria-label={`${unread} messages`}>{unread}</span>}
        </Button>
        <Button variant="outline" onClick={() => toast(`Calls go through a masked number so neither side sees the other's phone. Masked calling needs a telephony provider and is not connected in this SIMULATED demo: use Message.`)}>
          <Phone className="size-4" aria-hidden />Call
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side={phone ? 'bottom' : 'right'} className={cn('flex flex-col gap-0 p-0', phone ? 'max-h-[85dvh] rounded-t-3xl' : 'w-full sm:max-w-md')}>
          <SheetHeader className="border-b p-4">
            <SheetTitle>Message {other}</SheetTitle>
            <SheetDescription>Only you and {other} can see these messages. No phone numbers are shared.</SheetDescription>
          </SheetHeader>
          <ol className="flex-1 space-y-2 overflow-y-auto p-4" aria-live="polite" aria-label="Messages">
            {(msgs.data ?? []).length === 0 && <li className="py-6 text-center text-sm text-slate-500">No messages yet.</li>}
            {(msgs.data ?? []).map((m) => (
              <li key={m.id} className={cn('max-w-[80%] rounded-2xl px-3 py-2 text-sm', m.sender === me ? 'ml-auto bg-primary text-white' : 'bg-slate-100 text-slate-900')}>
                <span className="sr-only">{m.sender === me ? 'You' : other}: </span>{m.body}
                <span className={cn('mt-0.5 block text-[10px]', m.sender === me ? 'text-teal-100' : 'text-slate-500')}>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </li>
            ))}
          </ol>
          {live ? (
            <div className="space-y-2 border-t p-3">
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
                {QUICK[as].map((q) => (
                  <button key={q} type="button" disabled={send.isPending} onClick={() => send.mutate(q)}
                    className="h-8 shrink-0 rounded-full border bg-white px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-ring">{q}</button>
                ))}
              </div>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(text) }}>
                <label className="sr-only" htmlFor="chat-input">Message</label>
                <input id="chat-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Type a message"
                  className="h-11 min-w-0 flex-1 rounded-xl border bg-white px-3 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20" />
                <Button type="submit" size="icon" className="size-11" disabled={!text.trim() || send.isPending} aria-label="Send">
                  {send.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
                </Button>
              </form>
            </div>
          ) : <p className="border-t p-4 text-center text-xs text-slate-500">Chat closes when the trip ends.</p>}
        </SheetContent>
      </Sheet>
    </>
  )
}
