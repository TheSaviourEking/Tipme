import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { apiFetch, readWorthRetrying } from '../src/lib/session-client.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answers(...replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method });
    const [status, body] = replies[Math.min(calls.length, replies.length) - 1];
    return new Response(body === null ? 'no json' : JSON.stringify(body), {
      status,
    });
  };
  return calls;
}
const busy = [503, { error: { code: 'DEPENDENCY_UNAVAILABLE' } }];

test('a read answered 503 is tried once more, quietly', async () => {
  const calls = answers(busy, [200, { data: { n: 1 } }]);
  const result = await apiFetch('/v1/me/dashboard');
  assert.deepEqual(result, { ok: true, status: 200, data: { n: 1 } });
  assert.equal(calls.length, 2);
});

test('the edge’s bare 503 counts too', async () => {
  const calls = answers([503, null], [200, { data: 1 }]);
  assert.equal((await apiFetch('/v1/me/activity')).ok, true);
  assert.equal(calls.length, 2);
});

test('only once: a second 503 is the answer', async () => {
  const calls = answers(busy);
  const result = await apiFetch('/v1/me/dashboard');
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(calls.length, 2);
});

test('a write is never repeated', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const calls = answers(busy);
    const result = await apiFetch('/v1/me/withdrawals', { method, body: {} });
    assert.equal(result.status, 503);
    assert.equal(calls.length, 1, method);
  }
});

test('other failures are not retried', async () => {
  for (const reply of [
    [500, { error: { code: 'INTERNAL_ERROR' } }],
    [404, { error: { code: 'NOT_FOUND' } }],
    [503, { error: { code: 'PAYOUT_PROVIDER_UNAVAILABLE' } }],
    [503, { error: { code: 'PROVIDER_OUTCOME_UNKNOWN' } }],
  ]) {
    const calls = answers(reply);
    await apiFetch('/v1/me/dashboard');
    assert.equal(calls.length, 1, JSON.stringify(reply));
  }
  assert.equal(
    readWorthRetrying('GET', { ok: false, status: 0, code: 'NETWORK' }),
    false,
  );
});
