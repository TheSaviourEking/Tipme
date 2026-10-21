import { defineConfig, devices } from '@playwright/test';
import {
  API_ORIGIN,
  E2E_OPS_TOTP_KEY,
  E2E_REVALIDATE_SECRET,
  WEB_ORIGIN,
  stackEnv,
} from './tests/e2e/stack';

const env = (extra: Record<string, string>) => ({
  PATH: process.env.PATH ?? '',
  ...stackEnv,
  ...extra,
});

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  use: { baseURL: WEB_ORIGIN, trace: 'retain-on-failure' },
  // One pass at desktop width. Tests tagged @mobile also run at 360px.
  // Reflow at 320px is asserted inside those tests, so the suite is not run twice.
  projects: [
    {
      name: 'desktop',
      grepInvert: /@mobile/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      grep: /@mobile/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 800 },
      },
    },
  ],
  webServer: [
    {
      // Built by test:e2e with NEXT_PUBLIC_API_ORIGIN pointing at the API below.
      command: 'pnpm --filter @tipme/web start --port 3100',
      url: WEB_ORIGIN,
      stdout: 'pipe',
      timeout: 300_000,
      env: {
        PATH: process.env.PATH ?? '',
        API_INTERNAL_ORIGIN: API_ORIGIN,
        WEB_REVALIDATE_SECRET: E2E_REVALIDATE_SECRET,
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'node --import ./dist/instrument.js dist/main.js',
      cwd: './apps/api',
      url: `${API_ORIGIN}/health/ready`,
      stdout: 'pipe',
      reuseExistingServer: false,
      timeout: 300_000,
      env: env({
        HOST: '127.0.0.1',
        PORT: '4100',
        WEB_ORIGIN,
        STATUS_TOKEN_SECRET: 'e2e-only-status-token-secret-32-characters',
        AUTH_CODE_SECRET: 'e2e-only-auth-code-secret-32-characters!!',
        WEB_REVALIDATE_SECRET: E2E_REVALIDATE_SECRET,
        OPS_TOTP_KEY: E2E_OPS_TOTP_KEY,
        MESSAGING_PROVIDER: 'mock',
        RATE_LIMIT_AUTH_PER_HOUR: '10000',
        RATE_LIMIT_HANDLES_PER_MIN: '10000',
        // Every test tips from 127.0.0.1; the limiter itself is covered by integration tests.
        RATE_LIMIT_QUOTES_PER_MIN: '10000',
        RATE_LIMIT_INTENTS_PER_MIN: '10000',
        RATE_LIMIT_ANALYTICS_PER_MIN: '10000',
      }),
    },
    {
      command: 'node --import ./dist/instrument.js dist/main.js',
      cwd: './apps/worker',
      wait: { stdout: /worker\.started/ },
      stdout: 'pipe',
      reuseExistingServer: false,
      timeout: 300_000,
      env: env({
        LOG_LEVEL: 'info',
        RECONCILE_INTERVAL_MS: '500',
        RECONCILE_MIN_AGE_MS: '0',
      }),
    },
  ],
});
