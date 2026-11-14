import { defineConfig, devices } from '@playwright/test';
import { LANE, WEB_ORIGIN } from './stack';

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
  webServer: [
    {
      // The web asks /health/release for the launch time first (owner, 14 Nov 2026, #216).
      command: `node countdown-api-stub.mjs ${LANE.apiPort}`,
      port: LANE.apiPort,
      reuseExistingServer: false,
    },
    {
      command: `pnpm --filter @tipme/web start --port ${LANE.webPort}`,
      port: LANE.webPort,
      stdout: 'pipe',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        PATH: process.env.PATH ?? '',
        PRODUCTION_LAUNCH_AT: launchAt,
      },
    },
  ],
});
