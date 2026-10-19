import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { UnrecoverableError } from 'bullmq';
import { handleTraceProbe } from '../dist/handlers/trace-probe.js';

const job = (mode) => ({
  idempotencyKey: randomUUID(),
  mode,
  _trace: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
});
const context = (overrides = {}) => ({
  attemptsMade: 0,
  isProcessed: async () => false,
  markProcessed: async () => true,
  signal: new AbortController().signal,
  ...overrides,
});

test('a first delivery is processed and a repeat is a duplicate', async () => {
  const seen = new Set();
  const markProcessed = async (key) => !seen.has(key) && Boolean(seen.add(key));
  const payload = job('succeed');
  assert.equal(
    await handleTraceProbe(payload, context({ markProcessed })),
    'processed',
  );
  assert.equal(
    await handleTraceProbe(payload, context({ markProcessed })),
    'duplicate',
  );
});

test('fail-once fails the first attempt only', async () => {
  const payload = job('fail-once');
  await assert.rejects(
    handleTraceProbe(payload, context({ attemptsMade: 0 })),
    { message: 'probe_failure' },
  );
  assert.equal(
    await handleTraceProbe(payload, context({ attemptsMade: 1 })),
    'processed',
  );
});

test('fail-always fails every attempt', async () => {
  for (const attemptsMade of [0, 1, 2]) {
    await assert.rejects(
      handleTraceProbe(job('fail-always'), context({ attemptsMade })),
      {
        message: 'probe_failure',
      },
    );
  }
});

test('a failed attempt never consumes the idempotency marker', async () => {
  let marked = 0;
  const markProcessed = async () => Boolean(++marked);
  await assert.rejects(
    handleTraceProbe(job('fail-always'), context({ markProcessed })),
  );
  assert.equal(marked, 0);
});

test('a corrupt payload is unrecoverable and is not retried', async () => {
  await assert.rejects(
    handleTraceProbe({ mode: 'succeed' }, context()),
    (error) => {
      assert.ok(error instanceof UnrecoverableError);
      assert.equal(error.message, 'invalid_payload');
      return true;
    },
  );
});

test('an aborted job stops with a timeout', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    handleTraceProbe(job('succeed'), context({ signal: controller.signal })),
    {
      message: 'timeout',
    },
  );
});

test('slow work is cut off when the signal aborts mid-way', async () => {
  const signal = AbortSignal.timeout(50);
  await assert.rejects(
    handleTraceProbe(job('succeed'), context({ signal, delayMs: 5000 })),
    {
      message: 'timeout',
    },
  );
});

test('an already-processed delivery is a no-op that skips the work', async () => {
  let marked = 0;
  const outcome = await handleTraceProbe(
    job('fail-always'),
    context({
      isProcessed: async () => true,
      markProcessed: async () => Boolean(++marked),
    }),
  );
  assert.equal(outcome, 'duplicate');
  assert.equal(marked, 0);
});

test('the job timeout also bounds a hung dependency', async () => {
  const signal = AbortSignal.timeout(50);
  await assert.rejects(
    handleTraceProbe(
      job('succeed'),
      context({ signal, markProcessed: () => new Promise(() => {}) }),
    ),
    { message: 'timeout' },
  );
});
