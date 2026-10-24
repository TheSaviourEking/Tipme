import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feeLine } from '../src/lib/fee-line.ts';

test('the tip detail’s fee line says what was actually taken', () => {
  // Today's rule: TipMe's 10%, processing paid from it.
  assert.deepEqual(feeLine('17000', '3000'), {
    label: 'TipMe fee (includes processing)',
    minor: '20000',
  });
  // An older fee-free tip: TipMe took nothing; only the provider's processing came off.
  assert.deepEqual(feeLine('0', '3000'), {
    label: 'Payment processing (TipMe’s fee waived)',
    minor: '3000',
  });
  // A fee-free tip under today's rule: nothing came off.
  assert.deepEqual(feeLine('0', '0'), {
    label: 'TipMe fee (waived)',
    minor: '0',
  });
});
