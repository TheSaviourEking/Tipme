import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnrecoverableError } from 'bullmq';
import { handlePayoutStart } from '../dist/handlers/payout-start.js';

test('a payload without a payout id is not retried and reaches no provider', () => {
  for (const data of [null, {}, { payoutId: 'not-a-uuid' }]) {
    assert.throws(
      () =>
        handlePayoutStart(data, {
          db: {},
          provider: () => {
            throw new Error('no provider may be asked');
          },
        }),
      (error) =>
        error instanceof UnrecoverableError &&
        error.message === 'invalid_payload',
    );
  }
});
