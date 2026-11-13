import { execSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

// surface client-side [sweep] warnings in the test output
test.beforeEach(({ context }) => { context.on('console', (m) => { if (m.text().includes('[sweep]')) console.log('forwardWarnings', m.text()) }) })

// Test fixtures talk to the local DB directly (local stack only).
const sql = (q: string) => execSync('docker exec -i supabase_db_urban-pulse psql -U postgres -q -t -A', { input: q }).toString().trim()

test.afterEach(({}, info) => {
  if (info.status === info.expectedStatus) return
  console.log('EVENTS', sql(`select string_agg(to_char(at, 'MI:SS.MS') || ' ' || type || coalesce(' a' || (payload->>'attempt'), ''), ' | ' order by id) from ride_events`))
  console.log('RIDES', sql(`select string_agg(status || ' a' || attempt_no, ' | ') from rides`))
})
const resetRides = () => sql(`
  delete from ride_events where true; delete from ride_offers where true; delete from trip_group_members where true;
  delete from trip_groups where true; delete from rides where true;
  update driver_profiles d set online = true, lat = s.home_lat, lng = s.home_lng from demo_driver_seed s where s.user_id = d.user_id;
  update settings set fast_demo = true, offer_timeout_s = 15 where id;`)

async function login(page: Page, who: 'Rider' | 'Captain' | 'Judge') {
  await page.goto('/#/login')
  await page.getByRole('button', { name: who, exact: true }).click()
}

async function requestCab(page: Page) {
  await page.locator('#pickup').selectOption('forum')
  await page.locator('#drop').selectOption('mgmetro')
  const cab = page.getByRole('radio', { name: /^Cab/ })
  await expect(cab).toBeVisible()
  await cab.click()
  await page.getByRole('button', { name: 'Request Cab' }).click()
}

test.beforeEach(() => resetRides())

test('rider books a cab and a simulated captain completes the full lifecycle', async ({ page }) => {
  // only SIMULATED cabs online so fast-demo drives the trip end-to-end
  sql(`update driver_profiles set online = false where not is_simulated;`)
  await login(page, 'Rider')
  await requestCab(page)
  await expect(page.getByRole('list', { name: /Ride status/ })).toBeVisible()
  await page.screenshot({ path: 'e2e/shots/rider-tracking.png' })
  await expect(page.getByRole('heading', { name: 'Completed' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Estimated total')).toBeVisible()
  await page.getByRole('tab', { name: /History/ }).click()
  await expect(page.getByText('Forum Mall → MG Road Metro')).toBeVisible()
  const events = sql(`select string_agg(type, ',' order by id) from ride_events`)
  expect(events).toContain('status_completed')
})

test('real captain receives, declines -> auto reassignment; next offer accepted and driven to completion', async ({ browser }) => {
  // make captain1 the only eligible cab at first; a simulated cab comes online after the decline
  sql(`update driver_profiles d set online = false from profiles p where p.id = d.user_id and d.vehicle_category = 'cab' and d.is_simulated;`)
  const rider = await (await browser.newContext()).newPage()
  const cap = await (await browser.newContext()).newPage()
  await login(cap, 'Captain')
  await expect(cap.getByText("You're online")).toBeVisible()
  await login(rider, 'Rider')
  await requestCab(rider)

  const offer = cap.getByRole('alertdialog')
  await expect(offer).toBeVisible({ timeout: 15_000 })
  await expect(offer).toContainText('Forum Mall')
  await cap.screenshot({ path: 'e2e/shots/captain-offer.png' })

  sql(`update driver_profiles set online = true where vehicle_category = 'cab' and is_simulated;`)
  await offer.getByRole('button', { name: 'Decline' }).click()
  await expect(rider.getByText(/Reassigned automatically: attempt 2/)).toBeVisible({ timeout: 15_000 })
  await rider.screenshot({ path: 'e2e/shots/rider-reassigned.png' })
  await expect(rider.getByRole('heading', { name: 'Completed' })).toBeVisible({ timeout: 60_000 })
  const types = sql(`select string_agg(type, ',' order by id) from ride_events`)
  expect(types).toMatch(/offer_created,offer_rejected,offer_created,offer_accepted/)
})

test('captain accepts and drives the trip through every state', async ({ browser }) => {
  sql(`update driver_profiles set online = false where vehicle_category = 'cab' and is_simulated;`)
  const rider = await (await browser.newContext()).newPage()
  const cap = await (await browser.newContext()).newPage()
  await login(cap, 'Captain')
  await login(rider, 'Rider')
  await requestCab(rider)
  await cap.getByRole('alertdialog').getByRole('button', { name: 'Accept' }).click()
  await expect(rider.getByRole('heading', { name: 'Driver assigned' })).toBeVisible()
  for (const [btn, riderHeading] of [['Start driving to pickup', 'Driver on the way'], ['Rider picked up · start trip', 'On trip'], ['Complete trip', 'Completed']]) {
    await cap.getByRole('button', { name: btn }).click()
    await expect(rider.getByRole('heading', { name: riderHeading })).toBeVisible()
  }
  await rider.screenshot({ path: 'e2e/shots/rider-completed.png' })
})
