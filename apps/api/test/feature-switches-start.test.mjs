import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';

// Feature switches (owner, 14 Nov 2026): a copy starts while the database is away, as before; it
// logs that its switches were not written, naming no value, and they read the old variable or default.
test('with the database away a copy still starts, and logs that its switches were not written', async (t) => {
  const { origin, logs } = await startApp(t, { PRO_BILLING_ENABLED: 'true' });
  assert.equal((await fetch(`${origin}/health/live`)).status, 200);
  const failed = logs.filter((l) => l.event === 'feature_switch.seed_failed');
  assert.equal(failed.length, 1);
  assert.ok(!JSON.stringify(failed).includes('PRO_BILLING'));
});
