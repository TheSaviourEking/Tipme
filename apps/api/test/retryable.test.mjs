import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRetryablePersistenceError } from '../dist/webhooks/retryable.js';

test('only availability failures ask the provider to retry', () => {
  for (const sqlState of [
    undefined,
    '08006',
    '53300',
    '57P01',
    '40001',
    '40P01',
  ]) {
    assert.equal(
      isRetryablePersistenceError({ name: 'PersistenceError', sqlState }),
      true,
      String(sqlState),
    );
  }
  for (const sqlState of ['22P05', '23514', '23505', '42703']) {
    assert.equal(
      isRetryablePersistenceError({ name: 'PersistenceError', sqlState }),
      false,
      sqlState,
    );
  }
});
