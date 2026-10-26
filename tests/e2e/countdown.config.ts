import { defineConfig, devices } from '@playwright/test';
import { WEB_ORIGIN } from './stack';

const launchAt = process.env.E2E_PRODUCTION_LAUNCH_AT;
if (!launchAt)
  throw new Error('E2E_PRODUCTION_LAUNCH_AT is required for countdown checks.');

export default defineConfig({
  testDir: '.',
  testMatch: 'countdown.spec.ts',
  fullyParallel: false,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: WEB_ORIGIN,
    colorScheme: 'light',
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @tipme/web start --port 3100',
    port: 3100,
    stdout: 'pipe',
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      PATH: process.env.PATH ?? '',
      PRODUCTION_LAUNCH_AT: launchAt,
    },
  },
});
