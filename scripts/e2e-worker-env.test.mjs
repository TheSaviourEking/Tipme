import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The e2e worker confirms Pro purchases too (reconcile, every 500 ms) and can beat the webhook to
// it. As in production (deploy/compose.production.yml), it must then tell the web app the public
// page changed. Without the secret and the web origin it can't, and the page stays stale for up to
// 30 s (pro-buy.spec.ts's badge check failed this way in burn-in, 23 Nov 2026). The config imports
// extensionless modules, so its worker block is read as text.
test('the e2e worker can revalidate public pages, as the API does', () => {
  const source = readFileSync(
    new URL('../playwright.config.ts', import.meta.url),
    'utf8',
  );
  const from = source.indexOf("cwd: './apps/worker'");
  assert.notEqual(from, -1, 'no worker server in playwright.config.ts');
  const block = source.slice(from, source.indexOf('}),', from));
  assert.match(block, /WEB_REVALIDATE_SECRET: E2E_REVALIDATE_SECRET/);
  assert.match(block, /\bWEB_ORIGIN\b/);
});
