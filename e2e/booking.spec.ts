// Booking correctness: the selected vehicle is authoritative, wider search, long trips, and "Booking confirmed" only after
// acceptance is persisted. Local stack only; resets ride tables per test. Reject -> second cab is covered in core.spec.ts,
// concurrent accepts in supabase/tests/concurrency.ts.
import { execSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

const sql = (q: string) => execSync('docker exec -i supabase_db_urban-pulse psql -U postgres -q -t -A', { input: q }).toString().trim()

test.beforeEach(() => sql(`
  delete from reposition_moves where true; delete from ride_events where true; delete from ride_offers where true; delete from trip_group_members where true;
  delete from trip_groups where true; delete from rides where true;
  update driver_profiles d set online = true, lat = s.home_lat, lng = s.home_lng, location_source = 'simulated' from demo_driver_seed s where s.user_id = d.user_id;
  update driver_profiles d set online = false from profiles p where p.id = d.user_id and not d.is_simulated;
  update settings set fast_demo = true, offer_timeout_s = 15, auto_accept_s = 2, dispatch_policy = 'urban_pulse', last_reposition_at = now() + interval '1 hour' where id;`))
test.afterAll(() => sql(`update settings set auto_accept_s = 8, last_reposition_at = null where id;
  update driver_profiles d set online = true, lat = s.home_lat, lng = s.home_lng from demo_driver_seed s where s.user_id = d.user_id;`))

async function login(page: Page) {
  await page.goto('/#/login')
  await page.getByRole('button', { name: 'Rider', exact: true }).click()
  await page.waitForURL(/#\/rider/)
}
async function route(page: Page, to: [string, RegExp] = ['Railway Station', /^Belagavi Railway Station/]) {
  await page.getByRole('button', { name: /^Pickup point/ }).click(); await page.getByPlaceholder('Search a pickup landmark').fill('Rani Channamma')
  await page.getByRole('button', { name: /^Rani Channamma Circle/ }).last().click()
  await page.getByPlaceholder('Search a destination').fill(to[0])
  await page.getByRole('button', { name: to[1] }).last().click()
}
const accepted = () => sql(`select dp.vehicle_category || '/' || (e.payload->>'acceptance') from ride_events e
  join ride_offers o on o.id = (e.payload->>'offer_id')::uuid join driver_profiles dp on dp.user_id = o.driver_id where e.type = 'offer_accepted'`)

for (const cat of ['Auto', 'Bike'] as const) {
  test(`${cat}: simulated captain auto-accepts through the normal path, then "Booking confirmed"`, async ({ page }) => {
    await login(page); await route(page)
    await page.getByRole('radio', { name: new RegExp(`^${cat}`) }).click()
    await page.getByRole('button', { name: new RegExp(`^Confirm ${cat}`) }).click()
    await expect(page.getByRole('heading', { name: 'Booking confirmed' })
      .or(page.getByRole('heading', { name: 'Your captain is on the way' }))).toBeVisible({ timeout: 20_000 })
    expect(accepted()).toBe(`${cat.toLowerCase()}/simulated_auto_accept`)
  })
}

test('no cab nearby: Cab stays selected, no substitution, explicit alternative, wider search finds a cab', async ({ page }) => {
  sql(`update driver_profiles set online = false where vehicle_category = 'cab';
       update driver_profiles d set online = true, lat = 15.86723 + 0.0225, lng = 74.51172 from (select user_id from driver_profiles where vehicle_category = 'cab' and is_simulated order by plate limit 1) x where x.user_id = d.user_id;`)
  await login(page); await route(page)
  const cab = page.getByRole('radio', { name: /^Cab/ })
  await cab.click()
  await expect(cab).toHaveAttribute('aria-checked', 'true')
  await expect(cab).toContainText('0 captains within 2 km')
  await expect(page.getByRole('button', { name: /^No Cab captains within 2 km/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /^Choose Auto instead \(\d+ nearby\)/ })).toBeVisible()
  expect(sql(`select count(*) from rides`)).toBe('0')   // nothing was booked behind the passenger's back
  await page.getByRole('button', { name: 'Search for more Cab drivers within 3 km' }).click()
  await expect(cab).toContainText('1 captain within 3 km')
  await expect(cab).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: /^Confirm Cab/ }).click()
  await expect(page.getByRole('heading', { name: 'Booking confirmed' })
    .or(page.getByRole('heading', { name: 'Your captain is on the way' }))).toBeVisible({ timeout: 20_000 })
  expect(sql(`select category || '/' || (select search_radius_m from trip_groups) from rides`)).toBe('cab/3000')
  expect(accepted()).toBe('cab/simulated_auto_accept')
})

test('long route (RCC -> VTU, ~13 km): the auto request stays an auto', async ({ page }) => {
  await login(page); await route(page, ['Visvesvaraya', /^Visvesvaraya Technological University/])
  await page.getByRole('radio', { name: /^Auto/ }).click()
  await page.getByRole('button', { name: /^Confirm Auto/ }).click()
  await expect(page.getByRole('heading', { name: 'Booking confirmed' })
    .or(page.getByRole('heading', { name: 'Your captain is on the way' }))).toBeVisible({ timeout: 20_000 })
  expect(sql(`select category from rides`)).toBe('auto')
  expect(Number(sql(`select est_distance_km from rides`))).toBeGreaterThan(10)
  expect(accepted()).toBe('auto/simulated_auto_accept')
})

test('woman driver requested: a woman captain is matched and arrives; "Why" shows the score and made-up profile', async ({ page }) => {
  await login(page); await route(page)
  await page.getByRole('radio', { name: /^Cab/ }).click()
  await page.getByRole('switch', { name: 'Prefer a woman driver' }).click()
  await page.getByRole('button', { name: /^Confirm Cab/ }).click()
  await expect(page.getByRole('heading', { name: 'Booking confirmed' })
    .or(page.getByRole('heading', { name: 'Your captain is on the way' }))).toBeVisible({ timeout: 20_000 })
  expect(sql(`select p.display_name from rides r join profiles p on p.id = r.driver_id`)).toBe('Captain Farah')  // SIMULATED woman captain
  await page.getByRole('button', { name: /^Why Captain Farah/ }).click()
  await expect(page.getByText('MADE-UP DEMO DATA')).toBeVisible()
  await expect(page.getByText('Closest arrival')).toBeVisible()
})

test('shared cab: a simulated co-rider joins, the fare is split, and the captain gets one shared trip', async ({ page }) => {
  await login(page); await route(page)
  await page.getByRole('radio', { name: /^Cab/ }).click()
  await page.getByRole('switch', { name: 'Share this cab' }).click()
  sql(`update settings set auto_accept_s = 30 where id;`)   // keep it searching while the co-rider joins
  await page.getByRole('button', { name: /^Confirm shared Cab/ }).click()
  await page.getByRole('button', { name: 'Add a simulated co-rider (demo)' }).click()
  await expect(page.getByText(/Shared with 1 co-rider · you pay/)).toBeVisible({ timeout: 15_000 })
  expect(sql(`select count(*) from rides r join trip_group_members m on m.ride_id = r.id join trip_groups g on g.id = m.group_id where g.is_pool and g.status <> 'cancelled'`)).toBe('2')
  expect(sql(`select bool_and((fare->>'total')::numeric < (fare->>'solo_total')::numeric) from rides where status <> 'cancelled'`)).toBe('t')
})
