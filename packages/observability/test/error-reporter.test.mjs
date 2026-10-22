import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createErrorReporter } from '../dist/index.js';

// Error reporting (PR-011): Sentry's envelope format, sent by TipMe itself, with nothing that could
// carry personal data: no message text, no request, no cookies, no user.
const DSN = 'https://publickey123@errors.example.test/42';

function recorder() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: 200 });
  };
  return { calls, fetchImpl };
}

function secretError() {
  const error = new TypeError(
    'Cannot read profile of +2348031234567 ada@example.com message "thank you so much"',
  );
  return error;
}

test('with no DSN nothing is ever sent', async () => {
  const { calls, fetchImpl } = recorder();
  const reporter = createErrorReporter({
    dsn: undefined,
    service: 'api',
    fetchImpl,
  });
  reporter.capture(secretError(), { route: '/v1/me/profile' });
  await reporter.flush();
  assert.equal(calls.length, 0);
});

test('an error is sent as a Sentry envelope: type, frames, service, route and trace id — never the message', async () => {
  const { calls, fetchImpl } = recorder();
  const reporter = createErrorReporter({
    dsn: DSN,
    service: 'api',
    environment: 'staging',
    release: 'abc1234def00',
    fetchImpl,
  });
  reporter.capture(secretError(), {
    route: '/v1/me/profile',
    traceId: '0123456789abcdef0123456789abcdef',
  });
  await reporter.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://errors.example.test/api/42/envelope/');
  assert.match(
    calls[0].init.headers['x-sentry-auth'],
    /sentry_key=publickey123/,
  );
  const body = String(calls[0].init.body);
  for (const secret of [
    '2348031234567',
    'ada@example.com',
    'thank you',
    'Cannot read',
  ])
    assert.equal(body.includes(secret), false, secret);
  const [header, item, payload] = body
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.match(header.event_id, /^[0-9a-f]{32}$/);
  assert.equal(item.type, 'event');
  assert.equal(payload.level, 'error');
  assert.equal(payload.environment, 'staging');
  assert.equal(payload.release, 'abc1234def00');
  assert.deepEqual(payload.tags, { service: 'api', route: '/v1/me/profile' });
  assert.equal(
    payload.contexts.trace.trace_id,
    '0123456789abcdef0123456789abcdef',
  );
  const [exception] = payload.exception.values;
  assert.equal(exception.type, 'TypeError');
  assert.equal(exception.value, '(message withheld)');
  assert.ok(exception.stacktrace.frames.length > 0);
  assert.ok(
    exception.stacktrace.frames.every((f) => typeof f.lineno === 'number'),
  );
  for (const key of ['request', 'user', 'extra', 'breadcrumbs'])
    assert.equal(key in payload, false, key);
});

test('a known safe code (database state, operation code) is kept as the value', async () => {
  const { calls, fetchImpl } = recorder();
  const reporter = createErrorReporter({
    dsn: DSN,
    service: 'worker',
    fetchImpl,
  });
  const error = Object.assign(
    new Error('Database operation failed (SQLSTATE 40001)'),
    {
      name: 'PersistenceError',
      sqlState: '40001',
    },
  );
  reporter.capture(error, { job: 'reconcile.payments' });
  await reporter.flush();
  const payload = JSON.parse(String(calls[0].init.body).trim().split('\n')[2]);
  assert.equal(payload.exception.values[0].value, 'SQLSTATE 40001');
  assert.deepEqual(payload.tags, {
    service: 'worker',
    job: 'reconcile.payments',
  });
});

test('a burst is capped at 30 reports a minute, and a failing endpoint never throws', async () => {
  const { calls, fetchImpl } = recorder();
  const reporter = createErrorReporter({ dsn: DSN, service: 'api', fetchImpl });
  for (let i = 0; i < 50; i++) reporter.capture(new Error('x'), {});
  await reporter.flush();
  assert.equal(calls.length, 30);
  const broken = createErrorReporter({
    dsn: DSN,
    service: 'api',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  broken.capture(new Error('x'), {});
  await broken.flush();
});

test('a malformed DSN is refused when the reporter is created', () => {
  assert.throws(() =>
    createErrorReporter({ dsn: 'not a dsn', service: 'api' }),
  );
  assert.throws(() =>
    createErrorReporter({
      dsn: 'https://errors.example.test/42',
      service: 'api',
    }),
  );
});

test('stack frames come only from the stack itself, and paths outside the code are cut down', async () => {
  const { calls, fetchImpl } = recorder();
  const reporter = createErrorReporter({ dsn: DSN, service: 'api', fetchImpl });
  const error = new Error(
    'line one\n    at forged (/home/ada/private-notes.js:1:2)\nline three',
  );
  error.stack = [
    'Error: line one',
    '    at forged (/home/ada/private-notes.js:1:2)',
    'line three',
    '    at query (/home/runner/srv/node_modules/pg/lib/client.js:10:5)',
    '    at handler (/srv/tipme/apps/api/dist/profiles/x.js:3:4)',
    '    at elsewhere (/Users/ada/secret-project/tool.js:7:8)',
    '    at node:internal/process/task_queues:95:5',
  ].join('\n');
  reporter.capture(error);
  await reporter.flush();
  const event = JSON.parse(calls[0].init.body.trim().split('\n')[2]);
  const files = event.exception.values[0].stacktrace.frames.map(
    (f) => f.filename,
  );
  assert.deepEqual(files, [
    'node:internal/process/task_queues',
    'tool.js',
    'apps/api/dist/profiles/x.js',
    'node_modules/pg/lib/client.js',
  ]);
  const text = calls[0].init.body;
  for (const leak of ['private-notes', 'forged', '/home/', '/Users/ada'])
    assert.equal(text.includes(leak), false, leak);
});
