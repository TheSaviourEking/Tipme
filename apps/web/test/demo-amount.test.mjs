import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDemoAmount, formatDemoAmount } from '../src/lib/demo-amount.ts';

test('demo amount parsing uses exact minor units and rejects ambiguous input', () => {
  assert.equal(parseDemoAmount('1234.50'), 123450);
  assert.equal(parseDemoAmount('1.01'), 101);
  assert.equal(parseDemoAmount('100000'), 10000000);
  // Correctly grouped thousands separators are accepted.
  assert.equal(parseDemoAmount('1,000'), 100000);
  assert.equal(parseDemoAmount('1,500.50'), 150050);
  assert.equal(parseDemoAmount('100,000'), 10000000);
  for (const value of [
    '',
    '0',
    '-1',
    '1.001',
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
    assert.equal(parseDemoAmount(value), null);
  }
  assert.equal(formatDemoAmount(123450), 'NGN 1,234.50');
  assert.equal(formatDemoAmount(101), 'NGN 1.01');
});
