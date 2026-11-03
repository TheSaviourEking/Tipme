import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feeLine } from '../src/lib/fee-line.ts';

test('the tip detail’s fee line says what was actually taken', () => {
  // Today's rule: TipMe's 10%, processing paid from it.
  assert.deepEqual(feeLine('17000', '3000'), {
    label: 'TipMe fee (includes processing)',
    minor: '20000',
  });
  // Given the gross, the label names the real share, not a fixed one.
  assert.deepEqual(feeLine('17000', '3000', '200000'), {
    label: 'TipMe fee (10%, includes processing)',
    minor: '20000',
  });
  assert.deepEqual(feeLine('7000', '3000', '200000'), {
    label: 'TipMe fee (5%, includes processing)',
    minor: '10000',
  });
  assert.deepEqual(feeLine('14000', '1000', '200000'), {
    label: 'TipMe fee (7.5%, includes processing)',
    minor: '15000',
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

test('only a tip priced under the current rule says "includes processing"', () => {
  // Current rule, 10%: processing is paid from TipMe's share.
  assert.equal(
    feeLine('17000', '3000', '200000', true).label,
    'TipMe fee (10%, includes processing)',
  );
  // Current rule, a staff-set 7.5%.
  assert.equal(
    feeLine('12000', '3000', '200000', true).label,
    'TipMe fee (7.5%, includes processing)',
  );
  // Waived under the current rule.
  assert.equal(feeLine('0', '0', '200000', true).label, 'TipMe fee (waived)');
  // An older policy (10% plus processing on top): no share, never "includes processing".
  const old = feeLine('20000', '3000', '200000', false);
  assert.equal(old.label, 'TipMe fee and payment processing');
  assert.equal(old.minor, '23000');
  assert.ok(!old.label.includes('includes processing'));
});
