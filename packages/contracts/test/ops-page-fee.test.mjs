import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opsPageFeeSchema } from '../dist/index.js';

// Profit guards, Part 3: a staff-set page rate is none (null), 0 (fee-free, a deliberate grant) or
// at least 200 bps (2%). Nothing between 1 and 199.

const REASON = 'A deal for this page, 26 Nov 2026';

test('a page rate is null, 0, or 200 to 10000 basis points', () => {
  const ok = (feeBps) =>
    opsPageFeeSchema.safeParse({ feeBps, reason: REASON }).success;
  assert.equal(ok(null), true);
  assert.equal(ok(0), true);
  assert.equal(ok(200), true);
  assert.equal(ok(10000), true);
  assert.equal(ok(1), false);
  assert.equal(ok(100), false);
  assert.equal(ok(199), false);
  assert.equal(ok(10001), false);
  assert.equal(ok(-1), false);
  assert.equal(ok(250.5), false);
  assert.equal(ok('300'), false);
});
