import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bpsToPercent, percentToBps } from '../src/lib/fee-percent.ts';

test('a typed fee percentage becomes whole basis points, never a float', () => {
  assert.equal(percentToBps('10'), 1000);
  assert.equal(percentToBps('7.5'), 750);
  assert.equal(percentToBps(' 0.25% '), 25);
  assert.equal(percentToBps('0'), 0);
  assert.equal(percentToBps('100'), 10000);
  for (const bad of ['100.01', '101', '-1', '7.555', 'ten', '', '1e2'])
    assert.equal(percentToBps(bad), null, bad);
});

test('basis points read back as a plain percentage', () => {
  assert.equal(bpsToPercent(1000), '10%');
  assert.equal(bpsToPercent(750), '7.5%');
  assert.equal(bpsToPercent(25), '0.25%');
  assert.equal(bpsToPercent(0), '0%');
});
