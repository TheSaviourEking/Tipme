import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDemoAmount } from '../src/lib/demo-amount.ts';
import { amountOptions } from '../src/lib/tip-amounts.ts';

test('typed amounts use exact minor units and reject ambiguous input', () => {
  const { parse } = amountOptions(undefined);
  assert.equal(parse('1234.50'), 123450);
  assert.equal(parse('100000'), 10000000);
  // Correctly grouped thousands separators are accepted.
  assert.equal(parse('1,000'), 100000);
  assert.equal(parse('1,500.50'), 150050);
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
    '100,000.01',
    'Infinity',
    '100000.01',
    '0x10',
  ]) {
    assert.equal(parse(value), null, value);
  }
  assert.equal(formatDemoAmount(123450), 'NGN 1,234.50');
  assert.equal(formatDemoAmount(101), 'NGN 1.01');
});
