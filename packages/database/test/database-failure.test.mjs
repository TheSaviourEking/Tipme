import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  databaseFailureOf,
  guarded,
  isDatabaseAvailabilityFailure,
  PersistenceError,
  sqlStateOf,
} from '../dist/index.js';

const wrapped = (cause) =>
  Object.assign(new Error('Failed query: select secret'), { cause });

test('each way of failing is told apart, through a wrapper', () => {
  const cases = [
    [Object.assign(new Error('x'), { code: '53300' }), 'sqlstate', true],
    [Object.assign(new Error('x'), { code: '23505' }), 'sqlstate', false],
    [
      new Error('timeout exceeded when trying to connect'),
      'pool_wait_timeout',
      true,
    ],
    [
      new Error('Connection terminated due to connection timeout'),
      'connect_timeout',
      true,
    ],
    [new Error('Connection terminated unexpectedly'), 'connection_lost', true],
    [Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'network', true],
    [Object.assign(new Error('x'), { code: 'EPIPE' }), 'network', true],
  ];
  for (const [error, kind, available] of cases) {
    assert.equal(databaseFailureOf(wrapped(error))?.kind, kind);
    assert.equal(isDatabaseAvailabilityFailure(wrapped(error)), available);
  }
  assert.equal(databaseFailureOf(new TypeError('bug')), null);
  assert.equal(
    sqlStateOf(Object.assign(new Error('x'), { code: 'EPIPE' })),
    undefined,
  );
});

test('guarded keeps the cause, and never the driver’s message', async () => {
  const error = await guarded(async () => {
    throw wrapped(new Error('timeout exceeded when trying to connect'));
  }).catch((caught) => caught);
  assert.ok(error instanceof PersistenceError);
  assert.equal(error.failure.kind, 'pool_wait_timeout');
  assert.ok(!error.message.includes('secret'));
  const bug = await guarded(async () => {
    throw new TypeError('value secret');
  }).catch((caught) => caught);
  assert.deepEqual(bug.failure, { kind: 'unknown', causeName: 'TypeError' });
  assert.equal(isDatabaseAvailabilityFailure(bug), false);
});
