import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resumeWarnings } from '../src/lib/payout-resume-warnings.ts';

const clear = {
  takeoverReported: false,
  destinationReplaced: false,
  holdTouched: false,
};

test('nothing to warn about, no warning', () => {
  assert.deepEqual(resumeWarnings(clear), []);
});

test('a changed bank and a hold that touched the withdrawal each warn', () => {
  const [bank] = resumeWarnings({ ...clear, destinationReplaced: true });
  assert.match(bank, /changed their bank/);
  const [hold] = resumeWarnings({ ...clear, holdTouched: true });
  assert.match(hold, /hold/);
  assert.equal(
    resumeWarnings({ ...clear, destinationReplaced: true, holdTouched: true })
      .length,
    2,
  );
});

test('a takeover leads, and says the withdrawal may be the thief’s', () => {
  const warnings = resumeWarnings({
    takeoverReported: true,
    destinationReplaced: true,
    holdTouched: true,
  });
  assert.match(warnings[0], /thief/);
  assert.equal(warnings.length, 2);
});
