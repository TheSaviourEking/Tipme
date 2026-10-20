import { defineConfig, devices } from '@playwright/test';

/**
 * The release check (PR-010), run by `pnpm release:check` against any copy of TipMe.
 * Nothing here starts servers: the copy is wherever RELEASE_WEB and RELEASE_API point.
 */
const web = process.env.RELEASE_WEB;
if (!web)
  throw new Error(
    'Run this through `pnpm release:check` (RELEASE_WEB is not set).',
  );

export default defineConfig({
  testDir: __dirname,
  testMatch:
    process.env.RELEASE_FULL === '1'
      ? ['read-only.spec.ts', 'full.spec.ts']
      : ['read-only.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/release-check.json' }],
  ],
  use: {
    baseURL: web,
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: process.env.RELEASE_INSECURE === '1',
    ...devices['Pixel 7'],
  },
});
