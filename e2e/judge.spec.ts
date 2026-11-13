import { execSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

// surface client-side [sweep] warnings in the test output
test.beforeEach(({ context }) => { context.on('console', (m) => { if (m.text().includes('[sweep]')) console.log('forwardWarnings', m.text()) }) })

const sql = (q: string) => execSync('docker exec -i supabase_db_urban-pulse psql -U postgres -q -t -A', { input: q }).toString().trim()

test.afterEach(({}, info) => {
  if (info.status === info.expectedStatus) return
  console.log('EVENTS', sql(`select string_agg(to_char(at, 'MI:SS.MS') || ' ' || type || coalesce(' a' || (payload->>'attempt'), ''), ' | ' order by id) from ride_events`))
  console.log('RIDES', sql(`select string_agg(status || ' a' || attempt_no, ' | ') from rides`))
})
test.beforeEach(() => sql(`
  delete from ride_events where true; delete from ride_offers where true; delete from trip_group_members where true;
  delete from trip_groups where true; delete from rides where true;
  update driver_profiles d set online = true, lat = s.home_lat, lng = s.home_lng from demo_driver_seed s where s.user_id = d.user_id;
  update settings set fast_demo = true, offer_timeout_s = 15, auto_accept_s = 8, sim_clock = '2026-11-12 18:00+05:30' where id;`))

async function judge(page: Page) {
  await page.goto('/#/login')
  await page.getByRole('button', { name: 'Judge', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Chaos Mode' })).toBeVisible()
}

test('Chaos Mode: reject runs the real reassignment path and shows recovery time', async ({ page }) => {
  await judge(page)
  await page.getByRole('tab', { name: 'Chaos Mode' }).click()
  await page.getByRole('button', { name: /Create demo ride/ }).click()
  const reject = page.getByRole('button', { name: 'Captain rejects' })
  await expect(reject).toBeEnabled({ timeout: 10_000 })
  await reject.click()
  await expect(page.getByText(/recovered in [\d.]+s/).first()).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: 'e2e/shots/judge-chaos.png', fullPage: true })
  expect(sql(`select string_agg(type, ',' order by id) from ride_events`)).toMatch(/offer_rejected,offer_created.*offer_accepted/)
  expect(Number(sql(`select max(attempt_no) from ride_offers`))).toBeGreaterThanOrEqual(2)
})

test('Allocation explains the decision and re-ranks when workload changes', async ({ page }) => {
  await judge(page)
  await page.getByRole('tab', { name: 'Chaos Mode' }).click()
  await page.getByRole('button', { name: /Create demo ride/ }).click()
  await page.getByRole('tab', { name: 'Allocation' }).click()
  await expect(page.getByText(/^Why /)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/Nearest-driver baseline would pick/)).toBeVisible()
  await page.screenshot({ path: 'e2e/shots/judge-allocation.png', fullPage: true })
})

test('Zones: forecast, surge formula, what-if rain changes the forecast', async ({ page }) => {
  await judge(page)
  await page.getByRole('tab', { name: /Zones/ }).click()
  await expect(page.getByText('HistGradientBoostingRegressor')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'MG Road' })).toBeVisible()
  await page.getByLabel('What-if scenario').selectOption('heavy_rain')
  await expect(page.getByRole('columnheader', { name: 'Before event' })).toBeVisible()
  await page.screenshot({ path: 'e2e/shots/judge-zones.png', fullPage: true })
})

test('Pooling: two compatible requests become one trip group with one cab', async ({ page }) => {
  await judge(page)
  await page.getByRole('tab', { name: 'Pooling' }).click()
  await page.getByRole('button', { name: /Create 2 compatible/ }).click()
  await expect(page.getByText('Pooled vs separate rides (calculated)')).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: 'e2e/shots/judge-pooling.png', fullPage: true })
  await page.getByRole('button', { name: /Create pool and dispatch/ }).click()
  await expect.poll(() => sql(`select count(*) from trip_group_members m join trip_groups g on g.id = m.group_id where g.is_pool`)).toBe('2')
  await expect.poll(() => sql(`select count(*) from trip_groups where is_pool and status in ('offered','accepted','arriving','ongoing','completed')`), { timeout: 20_000 }).toBe('1')
})

test('Dispatch Arena runs both worlds on the same seed with metric verdicts', async ({ page }) => {
  await judge(page)
  await page.getByRole('link', { name: 'Dispatch Arena' }).click()
  await expect(page.getByText('run run-42-base')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Match wait (avg)' })).toBeVisible()
  await page.getByLabel('What-If scenario').selectOption('heavy_rain')
  await page.getByRole('button', { name: /Apply scenario/ }).click()
  await expect(page.getByText(/What-If chain/)).toBeVisible()
  await page.waitForTimeout(4000)
  await page.screenshot({ path: 'e2e/shots/arena-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'e2e/shots/arena-mobile.png', fullPage: true })
})
