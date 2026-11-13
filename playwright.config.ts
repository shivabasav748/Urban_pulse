import { defineConfig } from '@playwright/test'

// Uses the locally installed Chrome (no browser download). Needs `pnpm db:start` and a seeded DB.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  use: { baseURL: 'http://localhost:5173', channel: 'chrome', viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm dev --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true },
})
