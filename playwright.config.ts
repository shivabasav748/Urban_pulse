import { defineConfig } from '@playwright/test'

// Uses the locally installed Chrome (no browser download). Needs `pnpm db:start` and a seeded DB.
const PORT = Number(process.env.E2E_PORT ?? 5173)
export default defineConfig({
  testDir: 'e2e',
  workers: 1, // all specs share one local database and reset it in beforeEach
  timeout: 150_000,
  use: { baseURL: `http://localhost:${PORT}`, channel: 'chrome', viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure' },
  webServer: { command: `pnpm dev --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: true },
})
