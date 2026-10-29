import { defineConfig } from '@playwright/test'

const PORT = 3201

// End-to-end tests: a real browser against e2e/server.ts. One server and one database, so one worker,
// and the files run in order. Uses the installed Microsoft Edge; PLAYWRIGHT_CHANNEL=chrome for Chrome, or
// PLAYWRIGHT_CHANNEL=chromium after `npx playwright install chromium`.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node e2e/server.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: { PORT: String(PORT) },
    timeout: 60_000
  }
})
