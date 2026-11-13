// Genuine concurrency tests: separate signed-in sessions fire RPCs at the same time through the real API
// (PostgREST -> Postgres), many rounds each with random sub-5ms jitter so different interleavings occur.
// After every round a set of database invariants must hold.
// Run: pnpm db:concurrency   (local stack only; resets ride tables; removes its own test riders afterwards)
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]))
const URL = env.VITE_SUPABASE_URL, KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL)) throw new Error(`Refusing to run against non-local database: ${URL}`)

const DB = 'supabase_db_urban-pulse'
const sql = (q: string) => execSync(`docker exec -i ${DB} psql -U postgres -q -t -A -v ON_ERROR_STOP=1`, { input: q }).toString().trim()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ACTIVE = `('accepted','arriving','ongoing')`
const PICK = { lat: 12.9346, lng: 77.6113 }, DROP = { lat: 12.9755, lng: 77.6068 }

type Session = { email: string; id: string; rpc: (fn: string, args?: Record<string, unknown>) => Promise<unknown>; db: SupabaseClient }
async function session(email: string, signUpAsRider = false): Promise<Session> {
  const db = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  if (signUpAsRider) await db.auth.signUp({ email, password: 'demo1234', options: { data: { name: email.split('@')[0], role: 'rider' } } })
  const { data, error } = await db.auth.signInWithPassword({ email, password: 'demo1234' })
  if (error || !data.user) throw new Error(`sign-in failed for ${email}: ${error?.message}`)
  return { email, id: data.user.id, db, rpc: async (fn, args) => { const r = await db.rpc(fn, args); if (r.error) throw new Error(r.error.message); return r.data } }
}

/** Fire all calls together, each after 0-4 ms of random jitter. */
const fire = async (calls: (() => Promise<unknown>)[]) => {
  const rs = await Promise.allSettled(calls.map(async (c) => { await sleep(Math.random() * 4); return c() }))
  // errors caught inside sweep_exceptions (incl. deadlocks) never reach the Postgres log: collect them from its result
  for (const r of rs) {
    const items = r.status === 'fulfilled' ? ((r.value as { errors?: { step: string; error: string }[] } | null)?.errors ?? []) : []
    for (const it of items) { roundItemErrors.push(`${it.step}: ${it.error}`); if (/deadlock/.test(it.error)) caughtDeadlocks++ }
  }
  return rs
}
let roundItemErrors: string[] = []
let caughtDeadlocks = 0
const errs = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String(r.reason?.message ?? r.reason))

function setup(online: Session[], extra = '') {
  sql(`delete from ride_events where true; delete from ride_offers where true; delete from trip_group_members where true;
       delete from trip_groups where true; delete from rides where true;
       update settings set fast_demo = false, offer_timeout_s = 120 where id;
       update driver_profiles set online = false where true;
       ${online.map((c, i) => `update driver_profiles set online = true, lat = ${PICK.lat + i * 0.002}, lng = ${PICK.lng}, idle_since = now() where user_id = '${c.id}';`).join('\n')}
       ${extra}`)
}

const INVARIANTS = `select json_build_object(
  'captain_with_2_pending_offers', (select count(*) from (select 1 from ride_offers where outcome = 'pending' group by driver_id having count(*) > 1) x),
  'captain_with_2_active_trips', (select count(*) from (select 1 from trip_groups where status in ${ACTIVE} group by driver_id having count(*) > 1) x),
  'pending_offer_to_busy_captain', (select count(*) from ride_offers o where o.outcome = 'pending' and exists (select 1 from trip_groups g where g.driver_id = o.driver_id and g.status in ${ACTIVE})),
  'pending_offer_to_offline_captain', (select count(*) from ride_offers o join driver_profiles d on d.user_id = o.driver_id where o.outcome = 'pending' and not d.online),
  'group_with_2_pending_offers', (select count(*) from (select 1 from ride_offers where outcome = 'pending' group by group_id having count(*) > 1) x),
  'offered_group_without_1_pending', (select count(*) from trip_groups g where g.status = 'offered' and (select count(*) from ride_offers o where o.group_id = g.id and o.outcome = 'pending') <> 1),
  'pending_offer_on_non_offered_group', (select count(*) from ride_offers o join trip_groups g on g.id = o.group_id where o.outcome = 'pending' and g.status <> 'offered'),
  'active_group_without_accepted_offer', (select count(*) from trip_groups g where g.status in ${ACTIVE} and not exists (select 1 from ride_offers o where o.group_id = g.id and o.driver_id = g.driver_id and o.outcome = 'accepted')),
  'group_stuck_requested', (select count(*) from trip_groups where status = 'requested'),
  'ride_out_of_sync_with_group', (select count(*) from rides r join trip_group_members m on m.ride_id = r.id join trip_groups g on g.id = m.group_id where r.status <> 'cancelled' and (r.status <> g.status or r.driver_id is distinct from g.driver_id)),
  'same_captain_offered_twice_for_group', (select count(*) from (select 1 from ride_offers group by group_id, driver_id having count(*) > 1) x)
)`
function violations() {
  const j = JSON.parse(sql(INVARIANTS)) as Record<string, number>
  return Object.entries(j).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`)
}

type Round = () => Promise<{ outcome: string; problems: string[] }>
const results: { name: string; rounds: number; failed: number; outcomes: Record<string, number>; samples: string[] }[] = []
async function scenario(name: string, rounds: number, run: Round) {
  const outcomes: Record<string, number> = {}, samples: string[] = []
  let failed = 0
  for (let i = 0; i < rounds; i++) {
    roundItemErrors = []
    const { outcome, problems } = await run()
    const all = [...problems, ...violations(), ...(roundItemErrors.length ? [`sweep item errors: ${[...new Set(roundItemErrors)].join(', ')}`] : [])]
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    if (all.length) { failed++; if (samples.length < 3) samples.push(`round ${i + 1} [${outcome}]: ${all.join('; ')}`) }
  }
  results.push({ name, rounds, failed, outcomes, samples })
  console.log(`${failed ? 'FAIL' : 'PASS'}  ${name}  (${rounds - failed}/${rounds} rounds)  outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ×${v}`).join(', ')}`)
  samples.forEach((s) => console.log(`      ${s}`))
}

const request = (r: Session) => () => r.rpc('request_ride', { p_pickup_label: 'Forum Mall', p_lat: PICK.lat, p_lng: PICK.lng, p_drop_label: 'MG Road Metro', d_lat: DROP.lat, d_lng: DROP.lng, p_category: 'cab' })
const pendingOffer = async (c: Session) => (await c.db.from('ride_offers').select('id, group_id').eq('outcome', 'pending').eq('driver_id', c.id).maybeSingle()).data as { id: string; group_id: string } | null
const one = (q: string) => sql(q)
const expectOnly = (msgs: string[], pattern: RegExp, label: string) => msgs.filter((m) => !pattern.test(m)).map((m) => `unexpected ${label} error: ${m}`)

async function main() {
  const t0 = Date.now()
  const since = new Date().toISOString()
  const captainEmails = ['arjun', 'meera', 'kiran', 'farah', 'vikram', 'lakshmi', 'imran'].map((n) => `${n}@sim.up`)
  const caps = await Promise.all(captainEmails.map((e) => session(e)))
  const capsB = await Promise.all(captainEmails.slice(0, 2).map((e) => session(e))) // second browser tab for the same captains
  const riders = await Promise.all([session('rider@demo.up'), session('rider2@demo.up'), session('rider3@demo.up'),
    session('conc1@test.up', true), session('conc2@test.up', true)])
  const [X, Y] = caps, [X2] = capsB

  try {
    await scenario('1a. two riders request at once, one captain available', 30, async () => {
      setup([X])
      const rs = await fire([request(riders[0]), request(riders[1])])
      const st = one(`select string_agg(status, ',' order by status) from trip_groups`)
      const problems = errs(rs).map((e) => `request failed: ${e}`)
      if (st !== 'no_driver_found,offered') problems.push(`expected one offered + one no_driver_found, got ${st}`)
      return { outcome: st, problems }
    })

    await scenario('1b. five riders request at once, three captains available', 20, async () => {
      setup(caps.slice(0, 3))
      const rs = await fire(riders.map(request))
      const offered = Number(one(`select count(distinct driver_id) from ride_offers where outcome = 'pending'`))
      const st = one(`select string_agg(status, ',' order by status) from trip_groups`)
      const problems = errs(rs).map((e) => `request failed: ${e}`)
      if (offered !== 3) problems.push(`expected 3 distinct captains with offers, got ${offered} (${st})`)
      return { outcome: `${offered} captains offered`, problems }
    })

    await scenario('2a. captain accepts the same offer from two tabs at once', 30, async () => {
      setup([X]); await request(riders[0])()
      const o = await pendingOffer(X)
      if (!o) return { outcome: 'no offer', problems: ['fixture: no pending offer'] }
      const rs = await fire([() => X.rpc('respond_offer', { p_offer: o.id, p_accept: true }), () => X2.rpc('respond_offer', { p_offer: o.id, p_accept: true })])
      const e = errs(rs), problems = expectOnly(e, /conflict/, 'accept')
      if (e.length !== 1) problems.push(`expected exactly one accept to be refused, got ${e.length}`)
      if (one(`select status from trip_groups`) !== 'accepted') problems.push('group not accepted')
      return { outcome: 'one accepted, one refused', problems }
    })

    await scenario('2b. accept and reject of the same offer at once (second captain waiting)', 30, async () => {
      setup([X, Y]); await request(riders[0])()
      const o = await pendingOffer(X)
      if (!o) return { outcome: 'no offer', problems: ['fixture: no pending offer'] }
      const rs = await fire([() => X.rpc('respond_offer', { p_offer: o.id, p_accept: true }), () => X2.rpc('respond_offer', { p_offer: o.id, p_accept: false })])
      const first = one(`select outcome from ride_offers where id = '${o.id}'`)
      const live = Number(one(`select count(*) from ride_offers where outcome in ('pending','accepted')`))
      const problems = expectOnly(errs(rs), /conflict/, 'respond')
      if (live !== 1) problems.push(`expected exactly one live offer, got ${live}`)
      if (first === 'rejected' && one(`select driver_id from ride_offers where outcome = 'pending'`) !== Y.id) problems.push('reject won but ride was not re-offered to the other captain')
      return { outcome: `${first} won`, problems }
    })

    await scenario('2c. captain accepts while rider cancels', 25, async () => {
      setup([X]); const req = (await request(riders[0])()) as { ride_id: string }
      const o = await pendingOffer(X)
      if (!o) return { outcome: 'no offer', problems: ['fixture: no pending offer'] }
      const rs = await fire([() => X.rpc('respond_offer', { p_offer: o.id, p_accept: true }), () => riders[0].rpc('cancel_ride', { p_ride: req.ride_id })])
      const e = errs(rs), problems = expectOnly(e, /conflict/, 'accept/cancel')
      const st = one(`select r.status || '/' || g.status from rides r, trip_groups g`)
      if (st !== 'cancelled/cancelled') problems.push(`expected ride and group cancelled, got ${st}`)
      if (one(`select count(*) from ride_offers where outcome = 'pending'`) !== '0') problems.push('a pending offer survived the cancel')
      return { outcome: e.length ? 'cancel first' : 'accept first, then cancelled', problems }
    })

    await scenario('3a. captain goes offline while a ride is being dispatched to them', 40, async () => {
      setup([X, Y])
      const rs = await fire([request(riders[0]), () => X.rpc('set_online', { p_online: false })])
      const e = errs(rs), problems = expectOnly(e, /conflict/, 'request/offline')
      const to = one(`select driver_id from ride_offers where outcome = 'pending'`), xOnline = one(`select online from driver_profiles where user_id = '${X.id}'`)
      if (to === X.id && xOnline !== 't') problems.push('offer sits with a captain who is offline')
      if (!to) problems.push(`no offer made (group ${one(`select status from trip_groups`)})`)
      return { outcome: to === X.id ? 'offer reached captain, offline refused' : 'captain offline, offer went to next', problems }
    })

    await scenario('3b. captain accepts ride A while ride B is being dispatched', 40, async () => {
      setup([X, Y]); await request(riders[0])()
      const o = await pendingOffer(X)
      if (!o) return { outcome: 'no offer', problems: ['fixture: X has no offer'] }
      const rs = await fire([() => X.rpc('respond_offer', { p_offer: o.id, p_accept: true }), request(riders[1])])
      const problems = errs(rs).map((m) => `unexpected error: ${m}`)
      const bTo = one(`select o.driver_id from ride_offers o join trip_groups g on g.id = o.group_id where o.outcome = 'pending'`)
      if (bTo !== Y.id) problems.push(`ride B should be offered to the free captain, got ${bTo || 'nobody'}`)
      return { outcome: 'A accepted, B to free captain', problems }
    })

    await scenario('4a. five captains reject at once while three sessions sweep', 20, async () => {
      setup(caps.slice(0, 5))
      for (const r of riders) await request(r)()
      sql(caps.slice(5, 7).map((c, i) => `update driver_profiles set online = true, lat = ${PICK.lat - 0.002 * (i + 1)}, lng = ${PICK.lng} where user_id = '${c.id}';`).join(''))
      const offers = await Promise.all(caps.slice(0, 5).map(pendingOffer))
      if (offers.some((o) => !o)) return { outcome: 'fixture', problems: ['fixture: not every captain got an offer'] }
      const rs = await fire([...caps.slice(0, 5).map((c, i) => () => c.rpc('respond_offer', { p_offer: offers[i]!.id, p_accept: false })),
        ...riders.slice(0, 3).map((r) => () => r.rpc('sweep_exceptions'))])
      const problems = errs(rs).map((m) => `unexpected error: ${m}`)
      const rej = one(`select count(*) from ride_offers where outcome = 'rejected'`)
      const st = one(`select count(*) filter (where status = 'offered') || ' re-offered, ' || count(*) filter (where status = 'no_driver_found') || ' no driver' from trip_groups`)
      if (rej !== '5') problems.push(`expected 5 rejected offers, got ${rej}`)
      if (one(`select count(*) from trip_groups where status in ('offered','no_driver_found')`) !== '5') problems.push('a ride ended in an unexpected state')
      if (one(`select count(*) from ride_events where type = 'offer_rejected'`) !== '5') problems.push('rejection events not logged exactly once each')
      return { outcome: st, problems }
    })

    await scenario('4b. five offers expire and four sessions sweep at once', 20, async () => {
      setup(caps.slice(0, 5))
      for (const r of riders) await request(r)()
      sql(`update ride_offers set expires_at = now() - interval '1 second' where outcome = 'pending';` +
        caps.slice(5, 7).map((c, i) => `update driver_profiles set online = true, lat = ${PICK.lat - 0.002 * (i + 1)}, lng = ${PICK.lng} where user_id = '${c.id}';`).join(''))
      const rs = await fire(riders.slice(0, 4).map((r) => () => r.rpc('sweep_exceptions')))
      const problems = errs(rs).map((m) => `unexpected error: ${m}`)
      const n = one(`select count(*) from ride_events where type = 'offer_no_response'`)
      if (n !== '5') problems.push(`each expired offer must time out exactly once, got ${n} events`)
      return { outcome: one(`select count(*) filter (where status = 'offered') || ' re-offered, ' || count(*) filter (where status = 'no_driver_found') || ' no driver' from trip_groups`), problems }
    })
  } finally {
    // restore demo state first, so a later failure (e.g. reading the log) can never leave the demo dirty
    sql(`delete from ride_events where true; delete from ride_offers where true; delete from trip_group_members where true;
         delete from trip_groups where true; delete from rides where true;
         delete from auth.users where email like 'conc%@test.up';
         update settings set fast_demo = true, offer_timeout_s = 15, auto_accept_s = 8 where id;
         update driver_profiles d set online = true, lat = s.home_lat, lng = s.home_lng, idle_since = now() - make_interval(mins => s.seed_idle_min) from demo_driver_seed s where s.user_id = d.user_id;`)
    let deadlocks: number | string
    try { deadlocks = execSync(`docker logs ${DB} --since ${since} 2>&1`, { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n').filter((l) => /deadlock detected/.test(l)).length }
    catch { deadlocks = 'unknown (container log unreadable)' }
    const rounds = results.reduce((s, r) => s + r.rounds, 0), failed = results.reduce((s, r) => s + r.failed, 0)
    console.log(`\n${results.filter((r) => !r.failed).length}/${results.length} scenarios passed, ${rounds - failed}/${rounds} rounds, deadlocks: ${deadlocks} uncaught (Postgres log) + ${caughtDeadlocks} caught inside sweep_exceptions, ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    if (failed || deadlocks || caughtDeadlocks) process.exitCode = 1
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
