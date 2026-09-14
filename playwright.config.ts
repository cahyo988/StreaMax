import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    headless: true,
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
    viewport: { width: 1440, height: 1050 },
    trace: "retain-on-failure",
  },
});
