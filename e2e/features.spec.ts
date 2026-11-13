// Judges' feedback flows: vehicle types, women-driver preference, zone switching + repositioning, peak shortage,
// timeout reassignment, safety feedback and safety reports. Local stack only; resets ride tables per test.
import { execSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

const sql = (q: string) => execSync('docker exec -i supabase_db_urban-pulse psql -U postgres -q -t -A', { input: q }).toString().trim()

test.afterEach(({}, info) => {
  if (info.status === info.expectedStatus) return
  console.log('EVENTS', sql(`select string_agg(type || coalesce(' ' || (payload->>'reason'), ''), ' | ' order by id) from ride_events`))
  console.log('RIDES', sql(`select string_agg(status || ' a' || attempt_no, ' | ') from rides`))
})
test.beforeEach(() => sql(`
  delete from safety_report_audit where true; delete from safety_reports where true; delete from safety_feedback where true;
  delete from reposition_moves where true; delete from ride_events where true; delete from ride_offers where true; delete from trip_group_members where true;
  delete from trip_groups where true; delete from rides where true; delete from captain_preferences where not simulated;
  update driver_profiles d set online = true, lat = s.home_lat, lng = s.home_lng, zone_changed_at = null, op_zone = _zone_of(s.home_lat, s.home_lng)
    from demo_driver_seed s where s.user_id = d.user_id;
  update settings set fast_demo = true, offer_timeout_s = 15, auto_accept_s = 2, dispatch_policy = 'zone_aware', last_reposition_at = null,
    sim_clock = '2026-11-12 18:00+05:30' where id;`))
test.afterAll(() => sql(`update settings set auto_accept_s = 8, offer_timeout_s = 15 where id; delete from reposition_moves where true;
  update driver_profiles d set online = true, lat = s.home_lat, lng = s.home_lng, zone_changed_at = null from demo_driver_seed s where s.user_id = d.user_id;`))

async function login(page: Page, who: 'Rider' | 'Captain' | 'Judge') {
  await page.goto('/#/login')
  await page.getByRole('button', { name: who, exact: true }).click()
  await page.waitForURL(/#\/(rider|driver|judge)/)
}
async function route(page: Page, cat: 'Bike' | 'Auto' | 'Cab') {
  await page.getByPlaceholder('Search a pickup landmark').fill('Rani Channamma')
  await page.getByRole('button', { name: /^Rani Channamma Circle/ }).last().click()   // landmark list follows "Recent"
  await page.getByPlaceholder('Search a destination').fill('Railway Station')
  await page.getByRole('button', { name: /^Belagavi Railway Station/ }).last().click()
  await page.getByRole('radio', { name: new RegExp(`^${cat}`) }).click()
}
const offeredPlate = () => sql(`select dp.plate from ride_offers o join driver_profiles dp on dp.user_id = o.driver_id where o.outcome in ('pending','accepted') order by o.offered_at desc limit 1`)

test('rider books a bike and an auto: each is matched automatically to the right vehicle type', async ({ page }) => {
  await login(page, 'Rider')
  for (const cat of ['Bike', 'Auto'] as const) {
    await route(page, cat)
    await page.getByRole('button', { name: new RegExp(`^Confirm ${cat}`) }).click()
    await expect(page.getByRole('heading', { name: /captain/i })).toBeVisible()
    await expect.poll(() => sql(`select dp.vehicle_category from ride_offers o join driver_profiles dp on dp.user_id = o.driver_id order by o.offered_at desc limit 1`)).toBe(cat.toLowerCase())
    await page.getByRole('button', { name: /Cancel ride/ }).click()
    await expect(page.getByRole('button', { name: 'Book another ride' })).toBeVisible()
    await page.getByRole('button', { name: 'Book another ride' }).click()
    await page.getByRole('button', { name: /^Pickup point/ }).click()
  }
})

test('rider asks for a woman driver: only an opted-in captain is offered the ride', async ({ page }) => {
  await login(page, 'Rider')
  await route(page, 'Bike')
  const pref = page.getByRole('switch', { name: 'Prefer a woman driver' })
  await expect(pref).not.toBeChecked()          // off by default
  await pref.click()
  await expect(page.getByText('Woman driver requested. We will ask before matching anyone else.')).toBeVisible()
  await page.getByRole('button', { name: /^Confirm Bike/ }).click()
  await expect(page.getByText('Woman driver requested', { exact: true })).toBeVisible()
  await expect.poll(offeredPlate).toBe('KA-SIM-009') // the only opted-in bike within 2 km (SIMULATED demo opt-in)
  expect(sql(`select women_driver_pref from rides`)).toBe('t')
})

test('no eligible woman driver: the rider chooses; keep waiting, then remove the preference and get any captain', async ({ page }) => {
  await login(page, 'Rider')
  await route(page, 'Cab')
  await page.getByRole('switch', { name: 'Prefer a woman driver' }).click()
  await page.getByRole('button', { name: /^Confirm Cab/ }).click()
  await expect(page.getByRole('heading', { name: 'No suitable captains available right now' })).toBeVisible()
  await expect(page.getByText(/No woman captain is free near your pickup/)).toBeVisible()
  expect(sql(`select count(*) from ride_offers`)).toBe('0')   // nobody ineligible was offered it
  await page.getByRole('button', { name: 'Keep waiting for a woman captain' }).click()
  await expect(page.getByRole('heading', { name: 'Still looking for a woman captain' })).toBeVisible()
  await page.getByRole('button', { name: 'Search all captains instead' }).click()
  await expect(page.getByRole('heading', { name: /Captain assigned|Captain notified|Captain on the way|On trip/ })).toBeVisible({ timeout: 20_000 })
  expect(sql(`select women_driver_pref from rides`)).toBe('f')
  expect(sql(`select string_agg(type, ',' order by id) from ride_events`)).toMatch(/no_driver_found,search_restarted.*search_restarted,offer_created/)
})

test('captain switches zone: move is en route until arrival is observed', async ({ page }) => {
  await login(page, 'Captain')
  await expect(page.getByText('Where riders need you')).toBeVisible()
  const move = page.getByRole('button', { name: /^Move to / }).first()
  await expect(move).toBeEnabled({ timeout: 15_000 })
  await move.click()
  await expect(page.getByText(/^En route to /)).toBeVisible()
  await expect(page.getByText(/becomes your operational zone when your location shows you there/)).toBeVisible()
  expect(sql(`select status || '/' || source from reposition_moves`)).toBe('accepted/captain')
  await page.getByRole('button', { name: 'Cancel move' }).click()
  await expect(page.getByText(/^En route to /)).toHaveCount(0)
})

test('peak shortage: the system recommends repositioning and the captain accepts it', async ({ page, browser }) => {
  // KSCA (zone 7) has spare captains; Nehru Nagar / KLE (zone 3) is short at 18:00. captain1 is the donor nearest to zone 3.
  sql(`update driver_profiles set online = false where true;
       update driver_profiles d set online = true, lat = 15.8860, lng = 74.5520, location_source = 'simulated' from (select user_id from driver_profiles where is_simulated order by plate limit 2) x where x.user_id = d.user_id;
       update driver_profiles d set online = true, lat = 15.8862, lng = 74.5350, location_source = 'manual', location_updated_at = now() from profiles p where p.id = d.user_id and p.display_name = 'Captain Ravi';
       update settings set fast_demo = false where id;`)
  await login(page, 'Captain')
  const judge = await (await browser.newContext()).newPage()
  await login(judge, 'Judge')
  await expect(judge.getByText('Peak', { exact: true }).first()).toBeVisible()
  await judge.getByRole('button', { name: 'Run repositioning now' }).click()
  await expect(judge.getByText(/Repositioning pass: [1-9]/)).toBeVisible()
  await expect(page.getByText(/^Suggested: move to /)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/requests expected in 30 min/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Head there' }).click()
  await expect(page.getByText(/^En route to /)).toBeVisible()
  await expect(judge.getByText('accepted').first()).toBeVisible({ timeout: 10_000 })
})

test('captain times out: the ride is automatically reassigned to another captain', async ({ browser }) => {
  sql(`update driver_profiles set online = false where vehicle_category = 'cab' and is_simulated;`)
  const cap = await (await browser.newContext()).newPage()
  const rider = await (await browser.newContext()).newPage()
  await login(cap, 'Captain')
  await expect(cap.getByRole('button', { name: /You are online/ })).toBeVisible()
  await login(rider, 'Rider')
  await route(rider, 'Cab')
  await rider.getByRole('button', { name: /^Confirm Cab/ }).click()
  await expect(cap.getByRole('alertdialog')).toBeVisible({ timeout: 15_000 })
  sql(`update driver_profiles set online = true where vehicle_category = 'cab' and is_simulated;
       update ride_offers set expires_at = now() - interval '1 second' where outcome = 'pending';`)
  await expect(rider.getByText(/Reassigned automatically/)).toBeVisible({ timeout: 20_000 })
  expect(sql(`select string_agg(type || coalesce(':' || (payload->>'reason'), ''), ',' order by id) from ride_events`)).toMatch(/offer_no_response:timeout,offer_created/)
})

test('rider gives safety feedback and reports a safety concern; the judge reviews it', async ({ page, browser }) => {
  sql(`update driver_profiles set online = false where not is_simulated;`)
  await login(page, 'Rider')
  await route(page, 'Cab')
  await page.getByRole('button', { name: /^Confirm Cab/ }).click()
  await expect(page.getByRole('heading', { name: "You've arrived" })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('radio', { name: '4: Safe' }).click()
  await page.getByRole('radio', { name: '5: Very safe' }).first().click()
  await page.getByRole('button', { name: 'Send feedback' }).click()
  await expect(page.getByText(/Safety feedback sent/)).toBeVisible()
  expect(sql(`select count(*) from safety_feedback`)).toBe('1')

  await page.getByRole('button', { name: 'Report a concern' }).click()
  const sheet = page.getByRole('dialog', { name: /Report a safety concern/ })
  await sheet.getByLabel('Unsafe driving').check()
  await sheet.getByLabel('Describe it').fill('Speeding near the railway station')
  await sheet.getByRole('button', { name: 'Submit report' }).click()
  await expect(sheet.getByText(/You reported this trip/)).toBeVisible()
  expect(sql(`select status from safety_reports`)).toBe('open')

  const judge = await (await browser.newContext()).newPage()
  await login(judge, 'Judge')
  await judge.getByRole('tab', { name: 'Safety' }).click()
  await expect(judge.getByText('Speeding near the railway station')).toBeVisible()
  await judge.getByRole('button', { name: 'Resolve' }).click()
  await expect.poll(() => sql(`select status from safety_reports`)).toBe('resolved')
  expect(sql(`select count(*) from safety_report_audit`)).toBe('2')
})

test('fare model v2 is shown honestly: GST line for cabs, bike labelled a simulated service, captain earnings net of costs', async ({ page, browser }) => {
  await login(page, 'Rider')
  await route(page, 'Cab')
  await page.getByText('How this fare is calculated').click()
  await expect(page.getByText('GST (5%)')).toBeVisible()
  await expect(page.getByText(/Karnataka app-cab tariff/)).toBeVisible()
  await expect(page.getByText(/no per-minute charge/)).toBeVisible()
  await expect(page.getByText(/Time \(₹/)).toHaveCount(0)
  await page.getByRole('radio', { name: /^Bike/ }).click()
  await expect(page.getByText('SIMULATED SERVICE').first()).toBeVisible()
  await expect(page.getByText(/Bike taxis need an RTA permit in Karnataka/)).toBeVisible()
  const cap = await (await browser.newContext()).newPage()
  await login(cap, 'Captain')
  await cap.getByRole('button', { name: 'Earnings and trips' }).click()
  await expect(cap.getByText('Your payout (80%, ex-GST)')).toBeVisible()
  await expect(cap.getByText('Est. net earnings')).toBeVisible()
})
