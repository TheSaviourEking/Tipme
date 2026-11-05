import assert from 'node:assert/strict';
import { test } from 'node:test';
import { myTipsNoteSchema, myWithdrawalsQuerySchema } from '../dist/index.js';

test('withdrawals query takes a cursor and a limit of 1 to 50, nothing else', () => {
  for (const ok of [{}, { limit: '20' }, { cursor: 'abc' }]) {
    assert.equal(
      myWithdrawalsQuerySchema.safeParse(ok).success,
      true,
      JSON.stringify(ok),
    );
  }
  for (const bad of [
    { limit: '0' },
    { limit: '51' },
    { cursor: 'x'.repeat(201) },
    { status: 'paid' },
  ]) {
    assert.equal(
      myWithdrawalsQuerySchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  }
});

test('the note filter accepts only "with"', () => {
  assert.equal(myTipsNoteSchema.safeParse('with').success, true);
  assert.equal(myTipsNoteSchema.safeParse('without').success, false);
  assert.equal(myTipsNoteSchema.safeParse('').success, false);
});
