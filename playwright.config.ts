import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'https://engage.nkcswx.cn',
    trace: 'on-first-retry',
    headless: true,
  },
  timeout: 60000,
  expect: {
    timeout: 5000,
  },
  webServer: {
    command: 'echo "No web server needed"',
    port: 0,
    reuseExistingServer: true,
  },
});
