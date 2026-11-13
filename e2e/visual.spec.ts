// Visual QA capture: every main screen at mobile and desktop. Run: pnpm e2e e2e/visual.spec.ts
// Output: e2e/shots/visual/<viewport>-<screen>.png (git-ignored). Not an assertion suite.
import { execSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

const sql = (q: string) => execSync('docker exec -i supabase_db_urban-pulse psql -U postgres -q -t -A', { input: q }).toString().trim()
const VIEWPORTS = (process.env.VP ?? '390x844,1440x900').split(',').map((v) => v.split('x').map(Number) as [number, number])
const SCREENS = (process.env.SCREENS ?? 'login,rider-book,rider-track,captain,captain-offer,judge,arena').split(',')

test.beforeEach(() => sql(`
  delete from ride_events where true; delete from ride_offers where true; delete from trip_group_members where true;
  delete from trip_groups where true; delete from rides where true;
  update driver_profiles d set online = true, lat = s.home_lat, lng = s.home_lng from demo_driver_seed s where s.user_id = d.user_id;
  update settings set fast_demo = true, offer_timeout_s = 60, auto_accept_s = 60, sim_clock = '2026-11-12 18:00+05:30' where id;`))

// restore demo defaults so later specs and live demos aren't affected
test.afterAll(() => sql(`update settings set offer_timeout_s = 15, auto_accept_s = 8 where id;`))

const login = async (page: Page, who: string) => {
  await page.goto('/#/login')
  await page.getByRole('button', { name: who, exact: true }).click()
  await page.waitForURL(/#\/(rider|driver|judge)/)
}
const shot = async (page: Page, vp: string, name: string) => {
  await page.waitForTimeout(1200) // let map tiles settle
  await page.screenshot({ path: `e2e/shots/visual/${vp}-${name}.png`, fullPage: false })
}
const book = async (page: Page) => {
  // new first-run flow: search a pickup landmark, then a destination (no GPS in headless runs)
  await page.getByPlaceholder('Search a pickup landmark').fill('Rani Channamma')
  await page.getByRole('button', { name: /^Rani Channamma Circle/ }).click()
  await page.getByPlaceholder('Search a destination').fill('Railway Station')
  await page.getByRole('button', { name: /^Belagavi Railway Station/ }).click()
  await expect(page.getByRole('radio', { name: /^Cab/ })).toBeVisible()
  await page.getByRole('radio', { name: /^Cab/ }).click()
}

for (const [w, h] of VIEWPORTS) {
  const vp = `${w}x${h}`
  test.describe(vp, () => {
    test.use({ viewport: { width: w, height: h } })
    if (SCREENS.includes('login')) test(`login ${vp}`, async ({ page }) => { await page.goto('/#/login'); await shot(page, vp, 'login') })
    if (SCREENS.includes('rider-book')) test(`rider-book ${vp}`, async ({ page }) => {
      await login(page, 'Rider'); await shot(page, vp, 'rider-empty')
      await page.getByPlaceholder('Search a pickup landmark').fill('Rani Channamma'); await page.getByRole('button', { name: /^Rani Channamma Circle/ }).click(); await shot(page, vp, 'rider-pickup-set')
      await page.getByPlaceholder('Search a destination').fill('Railway Station'); await page.getByRole('button', { name: /^Belagavi Railway Station/ }).click()
      await expect(page.getByRole('radio', { name: /^Cab/ })).toBeVisible(); await page.getByRole('radio', { name: /^Cab/ }).click(); await shot(page, vp, 'rider-book')
    })
    if (SCREENS.includes('rider-track')) test(`rider-track ${vp}`, async ({ page }) => {
      await login(page, 'Rider'); await book(page); await page.getByRole('button', { name: 'Request Cab' }).click()
      await expect(page.getByRole('list', { name: /Ride status/ })).toBeVisible(); await shot(page, vp, 'rider-track')
    })
    if (SCREENS.includes('captain')) test(`captain ${vp}`, async ({ page }) => { await login(page, 'Captain'); await shot(page, vp, 'captain') })
    if (SCREENS.includes('captain-offer')) test(`captain-offer ${vp}`, async ({ browser }) => {
      sql(`update driver_profiles set online = false where vehicle_category = 'cab' and is_simulated;`)
      const cap = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage()
      const rider = await (await browser.newContext()).newPage()
      await login(cap, 'Captain'); await login(rider, 'Rider'); await book(rider)
      await rider.getByRole('button', { name: 'Request Cab' }).click()
      await expect(cap.getByRole('alertdialog')).toBeVisible({ timeout: 15_000 }); await shot(cap, vp, 'captain-offer')
    })
    if (SCREENS.includes('judge')) test(`judge ${vp}`, async ({ page }) => {
      await login(page, 'Judge'); await shot(page, vp, 'judge-live')
      for (const t of ['Allocation', 'Chaos Mode', 'Zones & forecast', 'Pooling', 'Metrics']) {
        await page.getByRole('tab', { name: t }).click(); await shot(page, vp, `judge-${t.split(' ')[0].toLowerCase()}`)
      }
    })
    if (SCREENS.includes('arena')) test(`arena ${vp}`, async ({ page }) => {
      await login(page, 'Judge'); await page.goto('/#/judge/arena')
      await expect(page.getByText(/run run-42/)).toBeVisible(); await page.waitForTimeout(4000); await shot(page, vp, 'arena')
    })
  })
}
