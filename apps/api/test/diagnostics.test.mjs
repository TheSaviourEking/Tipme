import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './helpers.mjs';

const post = (origin, body) =>
  fetch(`${origin}/v1/diagnostics/trace-probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('diagnostics routes do not exist unless enabled', async (t) => {
  const { origin } = await startApp(t);
  assert.equal((await post(origin, { mode: 'succeed' })).status, 404);
});

test('a probe fails fast with DEPENDENCY_UNAVAILABLE when Redis is down', async (t) => {
  const { origin } = await startApp(t, { DIAGNOSTICS_ENABLED: 'true' });
  const started = performance.now();
  const response = await post(origin, { mode: 'succeed' });
  assert.ok(
    performance.now() - started < 3000,
    'must not hang on an offline queue',
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DEPENDENCY_UNAVAILABLE');
});

test('invalid probes name the field and never echo values', async (t) => {
  const { origin } = await startApp(t, { DIAGNOSTICS_ENABLED: 'true' });
  const response = await post(origin, {
    mode: 'boom',
    note: '4111111111111111',
  });
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.ok(JSON.parse(text).error.fields.includes('mode'));
  assert.ok(!text.includes('4111111111111111'));
});

test('status lookups reject malformed job IDs', async (t) => {
  const { origin } = await startApp(t, { DIAGNOSTICS_ENABLED: 'true' });
  const response = await fetch(
    `${origin}/v1/diagnostics/trace-probe/not-a-uuid`,
  );
  assert.equal(response.status, 400);
  const { error } = await response.json();
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.deepEqual(error.fields, ['jobId']);
});
