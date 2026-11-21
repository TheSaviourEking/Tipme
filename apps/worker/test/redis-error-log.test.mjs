import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRateLimitedWarn,
  redisErrorCode,
  workerErrorLogger,
} from '../dist/redis-error-log.js';

class ReplyError extends Error {
  name = 'ReplyError';
}

test('the code is the first word of a Redis reply when it is all capitals', () => {
  for (const [message, code] of [
    ["OOM command not allowed when used memory > 'maxmemory'.", 'OOM'],
    ['MISCONF Redis is configured to save RDB snapshots', 'MISCONF'],
    ['NOSCRIPT No matching script. Please use EVAL.', 'NOSCRIPT'],
    ["READONLY You can't write against a read only replica.", 'READONLY'],
    ['LOADING Redis is loading the dataset in memory', 'LOADING'],
  ])
    assert.equal(redisErrorCode(new ReplyError(message)), code);
});

test('anything else is unknown, and the rest of the message is never returned', () => {
  for (const error of [
    new Error('Missing lock for job bull:tipme:jobs:42'),
    new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    new Error(''),
    new Error('A lone capital'),
    new Error('OOM'.repeat(20)),
    'OOM as a string, not an Error',
    undefined,
    null,
  ])
    assert.equal(redisErrorCode(error), 'unknown');
  assert.equal(redisErrorCode(new Error('OOM')), 'OOM');
});

function harness(windowMs) {
  let now = 1_000_000;
  const lines = [];
  const warn = createRateLimitedWarn({
    warn: (fields) => lines.push(fields),
    windowMs,
    now: () => now,
  });
  return { warn, lines, advance: (ms) => (now += ms) };
}

test('one line per code per 10 seconds; the next line counts what was held back', () => {
  const { warn, lines, advance } = harness(10_000);
  warn('OOM', { event: 'worker.error' });
  for (let i = 0; i < 2999; i += 1) {
    advance(3);
    warn('OOM', { event: 'worker.error' });
  }
  assert.deepEqual(lines, [{ event: 'worker.error', suppressed: 0 }]);
  advance(10_000);
  warn('OOM', { event: 'worker.error' });
  assert.deepEqual(lines[1], { event: 'worker.error', suppressed: 2999 });
  advance(10_000);
  warn('OOM', { event: 'worker.error' });
  assert.deepEqual(lines[2], { event: 'worker.error', suppressed: 0 });
  assert.equal(lines.length, 3);
});

test('each code has its own window', () => {
  const { warn, lines, advance } = harness(10_000);
  warn('OOM', { code: 'OOM' });
  warn('LOADING', { code: 'LOADING' });
  warn('OOM', { code: 'OOM' });
  advance(9_999);
  warn('LOADING', { code: 'LOADING' });
  assert.deepEqual(lines, [
    { code: 'OOM', suppressed: 0 },
    { code: 'LOADING', suppressed: 0 },
  ]);
  advance(1);
  warn('LOADING', { code: 'LOADING' });
  assert.deepEqual(lines[2], { code: 'LOADING', suppressed: 1 });
});

test('the window defaults to 10 seconds', () => {
  let now = 0;
  const lines = [];
  const warn = createRateLimitedWarn({
    warn: (fields) => lines.push(fields),
    now: () => now,
  });
  warn('OOM', {});
  now = 9_999;
  warn('OOM', {});
  assert.equal(lines.length, 1);
  now = 10_000;
  warn('OOM', {});
  assert.equal(lines.length, 2);
});

test("the worker's error handler logs the name and code only, once per 10 seconds", () => {
  let now = 0;
  const lines = [];
  const onError = workerErrorLogger({
    logger: { warn: (fields) => lines.push(fields) },
    now: () => now,
  });
  const oom = new ReplyError(
    "OOM command not allowed when used memory > 'maxmemory'. script: bull:tipme:jobs:secret-key",
  );
  for (let i = 0; i < 3000; i += 1) onError(oom);
  onError(new Error('Missing lock for job bull:tipme:jobs:secret-key'));
  now = 10_000;
  onError(oom);
  assert.deepEqual(lines, [
    { event: 'worker.error', error: 'ReplyError', code: 'OOM', suppressed: 0 },
    { event: 'worker.error', error: 'Error', code: 'unknown', suppressed: 0 },
    {
      event: 'worker.error',
      error: 'ReplyError',
      code: 'OOM',
      suppressed: 2999,
    },
  ]);
  assert.ok(!JSON.stringify(lines).includes('secret-key'));
});

test('the windows kept stay bounded: expired ones go, and past 64 codes new ones share "other"', () => {
  const { warn, lines, advance } = harness(10_000);
  const code = (i) =>
    `C${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`;
  for (let i = 0; i < 64; i += 1) warn(code(i), { i });
  assert.equal(lines.length, 64);
  // Past the limit, and every window still open: new codes are limited together.
  warn(code(64), { i: 64 });
  warn(code(65), { i: 65 });
  assert.equal(lines.length, 65);
  assert.deepEqual(lines[64], { i: 64, suppressed: 0 });
  // Once the open windows have expired they are dropped, and a new code gets its own again.
  advance(10_000);
  warn(code(66), { i: 66 });
  warn(code(67), { i: 67 });
  assert.equal(lines.length, 67);
});
