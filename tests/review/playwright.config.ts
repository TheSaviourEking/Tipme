import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import base from '../../playwright.config';

// The owner's review gallery (docs/superpowers/plans/2026-11-03-screen-redesign.md, Task 1), on the
// same stack as e2e. Paths in the base config are relative to the repository root, so they are
// resolved from there rather than from this folder.
const root = resolve(__dirname, '../..');
const servers = Array.isArray(base.webServer)
  ? base.webServer
  : base.webServer
    ? [base.webServer]
    : [];

export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: resolve(root, 'test-results/review'),
  globalSetup: resolve(root, 'tests/e2e/global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { ...base.use, trace: 'off', screenshot: 'off' },
  webServer: servers.map((server) => ({
    ...server,
    cwd: resolve(root, server.cwd ?? '.'),
  })),
  projects: [
    {
      name: 'desktop',
      grepInvert: /@serve/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'phone',
      grepInvert: /@serve/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: 'serve', grep: /@serve/, use: { ...devices['Desktop Chrome'] } },
  ],
});
