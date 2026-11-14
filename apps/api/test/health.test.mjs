import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';

test('HTTP liveness is explicit and unknown/payment routes remain unavailable', async (t) => {
  const { origin } = await startApp(t);
  for (const path of ['/health', '/health/live']) {
    const health = await fetch(`${origin}${path}`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'api' });
  }
  for (const path of ['/missing', '/api/v1/tip-intents']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
});

test('/health/release reports bachs-live and paymentsLive false', async () => {
  const { ReleaseInfoController } =
    await import('../dist/release/release.controller.js');
  // A production copy that boots on bachs-live with live payments switched off: the web reads
  // these two fields to keep checkout closed.
  const { data } = await new ReleaseInfoController(
    {
      RELEASE_KIND: 'live',
      DEPLOYMENT_MODE: 'production',
      NODE_ENV: 'production',
      PAYMENT_PROVIDER: 'bachs-live',
      PAYMENTS_LIVE_ENABLED: false,
    },
    // No database here: the switches it also reports fall back to their defaults.
    {
      db: {
        select() {
          throw new Error('no database in a unit test');
        },
      },
    },
  ).info();
  assert.equal(data.paymentProvider, 'bachs-live');
  assert.equal(data.paymentsLive, false);
});
