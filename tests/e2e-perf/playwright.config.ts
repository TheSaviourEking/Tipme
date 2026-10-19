import path from 'node:path';
import base from '../../playwright.config';

/** Lab LCP sample (`pnpm perf:lab`, after `pnpm test:e2e` has built the stack). Not a field measurement. */
const root = path.resolve(__dirname, '../..');
export default {
  ...base,
  testDir: __dirname,
  testMatch: 'lcp.spec.ts',
  globalSetup: path.join(root, 'tests/e2e/global-setup.ts'),
  projects: [base.projects![1]],
  webServer: (base.webServer as { cwd?: string }[]).map((server) => ({
    ...server,
    cwd: path.join(root, server.cwd ?? '.'),
  })),
};
