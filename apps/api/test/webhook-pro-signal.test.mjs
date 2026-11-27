import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebhookService } from '../dist/webhooks/webhook.service.js';

// Live updates (addendum §3.7): after confirmProCheckout resolves, the webhook path sends one
// pro.changed to the buyer's page only when that call settled the purchase, and never for a
// business's purchase, which has no page (rulings L-R15, L-R16).

const PAGE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function service() {
  const sent = [];
  const webhooks = new WebhookService(
    { db: null },
    null,
    { warn: () => undefined },
    async (message) => {
      sent.push(message);
    },
  );
  // signalPurchase is private in TypeScript; the test reaches it as JavaScript.
  return { sent, signal: (result) => webhooks.signalPurchase(result) };
}

test('a settled purchase sends one pro.changed to its page', () => {
  const { sent, signal } = service();
  signal({ settled: true, profileId: PAGE });
  assert.deepEqual(sent, [{ to: { profile: PAGE }, type: 'pro.changed' }]);
});

test('already settled, still pending, or a late credit sends nothing', () => {
  const { sent, signal } = service();
  signal({ settled: false, profileId: PAGE });
  assert.deepEqual(sent, []);
});

test('a business’s purchase sends nothing: it has no page', () => {
  const { sent, signal } = service();
  signal({ settled: true, profileId: null });
  assert.deepEqual(sent, []);
});
