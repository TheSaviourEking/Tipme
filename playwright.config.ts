import { defineConfig, devices } from '@playwright/test';
import {
  API_ORIGIN,
  E2E_MAIL_SEAL_KEY,
  E2E_OPS_TOTP_KEY,
  E2E_REVALIDATE_SECRET,
  LANE,
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
  // The @alone stage runs after the suite in the same job (scripts/run-e2e.mjs), and Playwright
  // empties its output folder when it starts: in a folder of its own, it leaves the suite's failure
  // screenshots for CI to upload.
  outputDir: process.env.E2E_ALONE
    ? `./${LANE.outputDir}/alone`
    : `./${LANE.outputDir}`,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
    colorScheme: 'light',
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
  },
  // One pass at desktop width. Tests tagged @mobile also run at 360px.
  // Reflow at 320px is asserted inside those tests, so the suite is not run twice.
  //
  // @alone tests remove every other staff member, and some change the global switch, so nothing may
  // run beside them. A project that depends on the others would stop --shard splitting those, so
  // they are a separate run: E2E_ALONE=1, as `pnpm test:e2e` does (scripts/run-e2e.mjs).
  projects: process.env.E2E_ALONE
    ? [
        {
          name: 'desktop-alone',
          grep: /@alone/,
          fullyParallel: false,
          workers: 1,
          use: { ...devices['Desktop Chrome'] },
        },
      ]
    : [
        {
          name: 'desktop',
          grepInvert: /@mobile|@alone/,
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
      // Next prints Ready and then never answers the homepage request Playwright
      // uses as a health check, so wait until the port accepts a connection.
      command: `pnpm --filter @tipme/web start --port ${LANE.webPort}`,
      port: LANE.webPort,
      stdout: 'pipe',
      timeout: 300_000,
      env: {
        PATH: process.env.PATH ?? '',
        API_INTERNAL_ORIGIN: API_ORIGIN,
        WEB_REVALIDATE_SECRET: E2E_REVALIDATE_SECRET,
        // The pilot notice must stay hidden on this pretend-provider stack even when the setting
        // is on (tests/e2e/pilot-notice.spec.ts), so every e2e run sets it.
        PILOT_NOTICE: 'on',
      },
      reuseExistingServer: false,
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
        PORT: String(LANE.apiPort),
        WEB_ORIGIN,
        STATUS_TOKEN_SECRET: 'e2e-only-status-token-secret-32-characters',
        AUTH_CODE_SECRET: 'e2e-only-auth-code-secret-32-characters!!',
        WEB_REVALIDATE_SECRET: E2E_REVALIDATE_SECRET,
        OPS_TOTP_KEY: E2E_OPS_TOTP_KEY,
        MAIL_SEAL_KEY: E2E_MAIL_SEAL_KEY,
        MAIL_DEFAULT_PROVIDER: 'mock',
        RATE_LIMIT_AUTH_PER_HOUR: '10000',
        RATE_LIMIT_HANDLES_PER_MIN: '10000',
        // Every test tips from 127.0.0.1; the limiter itself is covered by integration tests.
        RATE_LIMIT_QUOTES_PER_MIN: '10000',
        RATE_LIMIT_INTENTS_PER_MIN: '10000',
        RATE_LIMIT_ANALYTICS_PER_MIN: '10000',
        RATE_LIMIT_REPORTS_PER_HOUR: '10000',
        RATE_LIMIT_QR_ART_PER_HOUR: '10000',
        // Every photo, cover and logo upload and every cover-design save comes from 127.0.0.1, and CI
        // runs a changed spec five times; both limits are covered by
        // tests/integration/avatars-limit.test.mjs.
        RATE_LIMIT_AVATARS_PER_HOUR: '10000',
        RATE_LIMIT_COVER_DESIGNS_PER_HOUR: '10000',
        // Every Studio save, publish and discard comes from 127.0.0.1 too (a burn-in passes 60 a
        // minute); the limit is covered by tests/integration/studio-discard-limit.test.mjs.
        RATE_LIMIT_STUDIO_DRAFTS_PER_MIN: '10000',
        LIVE_UPDATES_ENABLED: 'true',
        // TipMe for businesses: the e2e stack tests it on (it is off by default everywhere else).
        BUSINESS_ENABLED: 'true',
        // Business release 2 (R2-C1's share agreement, R2-B's Money section: only shares fill a
        // business's own balance), also off by default everywhere else.
        BUSINESS_SHARES_ENABLED: 'true',
        // Business sign-up (Phase D): the "Get tipped" / "For businesses" fork, a business with no
        // page, and the account-menu switcher. Seeds the business_signup switch on the lane's fresh
        // database, as the lines above seed theirs; off by default everywhere else.
        BUSINESS_SIGNUP_ENABLED: 'true',
        // Paid Pro (ADR-0015): buying a month on pretend money, off by default everywhere else.
        // tests/e2e/pro-buy.spec.ts answers the price read itself to show the "off" state.
        PRO_BILLING_ENABLED: 'true',
        // Campaign pages (Pro): seeds the campaign_pages switch on the lane's fresh database; off by
        // default everywhere else.
        CAMPAIGN_PAGES_ENABLED: 'true',
        // Page Studio (Pro): seeds the page_studio switch on the lane's fresh database, so the Studio
        // routes answer in the e2e stack; off by default everywhere else, and in no deploy file.
        PAGE_STUDIO_ENABLED: 'true',
        // Staff "Refund tip" (owner, 14 Nov 2026): seeds the tip_refunds switch on the lane's fresh
        // database; off by default everywhere else, and in no deploy file.
        TIP_REFUNDS: 'on',
        RATE_LIMIT_BUSINESS_PUBLIC_PER_MIN: '10000',
        RATE_LIMIT_BUSINESS_NOTE_PER_HOUR: '10000',
        // Every page opens a stream from 127.0.0.1.
        RATE_LIMIT_LIVE_CONNECT_PER_MIN: '10000',
        // The Get paid card now checks a name on its own, so many tests check from 127.0.0.1.
        // The 10-a-day limit per person still applies (every test is a new person).
        RATE_LIMIT_BANK_RESOLVE_PER_HOUR: '10000',
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
        MAIL_SEAL_KEY: E2E_MAIL_SEAL_KEY,
        RECONCILE_INTERVAL_MS: '500',
        RECONCILE_MIN_AGE_MS: '0',
      }),
    },
  ],
});
