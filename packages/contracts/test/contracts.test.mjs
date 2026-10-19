import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  JOB_NAMES,
  apiErrorCodes,
  traceProbeJobSchema,
  traceProbeRequestSchema,
} from '../dist/index.js';

const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

test('trace probe requests accept known modes only, strictly', () => {
  assert.equal(
    traceProbeRequestSchema.safeParse({ mode: 'succeed' }).success,
    true,
  );
  assert.equal(
    traceProbeRequestSchema.safeParse({ mode: 'explode' }).success,
    false,
  );
  assert.equal(
    traceProbeRequestSchema.safeParse({ mode: 'succeed', extra: 1 }).success,
    false,
  );
  assert.equal(
    traceProbeRequestSchema.safeParse({
      mode: 'succeed',
      note: 'x'.repeat(121),
    }).success,
    false,
  );
});

test('trace probe jobs carry trace context and never free text', () => {
  const job = {
    idempotencyKey: randomUUID(),
    mode: 'succeed',
    _trace: { traceparent },
  };
  assert.equal(traceProbeJobSchema.safeParse(job).success, true);
  assert.equal(
    traceProbeJobSchema.safeParse({ ...job, note: 'x' }).success,
    false,
  );
  assert.equal(
    traceProbeJobSchema.safeParse({
      ...job,
      _trace: { traceparent: 'garbage' },
    }).success,
    false,
  );
});

test('error codes and job names are stable identifiers', () => {
  assert.ok(apiErrorCodes.includes('DEPENDENCY_UNAVAILABLE'));
  assert.equal(JOB_NAMES.traceProbe, 'diagnostics.trace-probe');
});
