import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webhookAlert } from '../dist/handlers/payment-reserve.js';

const URL_WITH_SECRET =
  'https://hooks.example.test/services/T0/B0/very-secret-token';

test('the alert is posted as {"text": ...} to the alert route', async () => {
  const calls = [];
  const alert = webhookAlert({
    url: URL_WITH_SECRET,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    },
  });
  await alert('Payment reserve is low');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_WITH_SECRET);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: 'Payment reserve is low',
  });
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  // A redirect could carry the text somewhere else.
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('a failed alert throws an error that does not contain the route address', async () => {
  const failures = [
    async () => {
      throw new TypeError(`fetch failed: ${URL_WITH_SECRET}`);
    },
    async () => new Response('nope', { status: 500 }),
    async () => new Response('gone', { status: 404 }),
  ];
  for (const fetchImpl of failures) {
    const alert = webhookAlert({ url: URL_WITH_SECRET, fetchImpl });
    await assert.rejects(
      () => alert('x'),
      (error) =>
        error instanceof Error &&
        !String(error.message).includes('very-secret-token') &&
        !String(error.stack).includes('very-secret-token') &&
        !String(error.cause ?? '').includes('very-secret-token'),
    );
  }
});

test('with no alert route the text goes to the log, once, and counts as sent', async () => {
  const entries = [];
  const alert = webhookAlert({
    url: undefined,
    log: (entry) => entries.push(entry),
  });
  await alert('Payment reserve is low');
  assert.deepEqual(entries, [
    { event: 'reserve.alert_unrouted', text: 'Payment reserve is low' },
  ]);
});
