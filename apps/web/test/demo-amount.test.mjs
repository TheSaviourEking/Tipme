import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDemoAmount, formatNaira } from '../src/lib/demo-amount.ts';
import { amountOptions } from '../src/lib/tip-amounts.ts';

test('typed amounts use exact minor units and reject ambiguous input', () => {
  const { parse } = amountOptions(undefined);
  assert.equal(parse('2234.50'), 223450);
  assert.equal(parse('100000'), 10000000);
  // Correctly grouped thousands separators are accepted.
  assert.equal(parse('2,000'), 200000);
  assert.equal(parse('2,500.50'), 250050);
  assert.equal(parse('100,000'), 10000000);
  for (const value of [
    '',
    '0',
    '-1',
    '1.01',
    '1000.001',
    '1e3',
    '1,50',
    '1,0000',
    ',100',
    '1,,000',
    '1000,000',
    'Infinity',
    '0x10',
  ]) {
    assert.equal(parse(value), null, value);
  }
  assert.equal(formatDemoAmount(123450), 'NGN 1,234.50');
  assert.equal(formatDemoAmount(101), 'NGN 1.01');
});

// One money format on every recipient and supporter screen: ₦1,800, with kobo only when there are some.
test('formatNaira takes a decimal string, a number or a bigint', () => {
  assert.equal(formatNaira('180000'), '₦1,800');
  assert.equal(formatNaira(180000), '₦1,800');
  assert.equal(formatNaira(BigInt(180000)), '₦1,800');
  assert.equal(formatNaira('180050'), '₦1,800.50');
  assert.equal(formatNaira('180005'), '₦1,800.05');
  assert.equal(formatNaira('5'), '₦0.05');
  assert.equal(formatNaira('0'), '₦0');
});

test('formatNaira keeps every digit of a balance too large for a double', () => {
  assert.equal(
    formatNaira('123456789012345678901234'),
    '₦1,234,567,890,123,456,789,012.34',
  );
});
