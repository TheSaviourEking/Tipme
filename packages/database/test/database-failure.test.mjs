import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  databaseFailureOf,
  guarded,
  isDatabaseAvailabilityFailure,
  PersistenceError,
  sqlStateOf,
} from '../dist/index.js';

// As drizzle wraps what the driver throws: the one route for a network code to count.
class DrizzleQueryError extends Error {
  constructor(cause) {
    super('Failed query: select secret');
    this.cause = cause;
  }
}
const wrapped = (cause) => new DrizzleQueryError(cause);

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

test('a network code counts only from the database layer, and only a real one', () => {
  const fetchFailed = (code) =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('x'), { code }),
    });
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOENT', 'EPIPE']) {
    assert.equal(databaseFailureOf(fetchFailed(code)), null, code);
    assert.equal(isDatabaseAvailabilityFailure(fetchFailed(code)), false, code);
  }
  for (const code of ['ENOENT', 'EACCES', 'EISDIR', 'EMFILE']) {
    const error = wrapped(Object.assign(new Error('x'), { code }));
    assert.equal(databaseFailureOf(error), null, code);
  }
});

test('a client that lost its connection is connection_lost', () => {
  for (const message of [
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
  ])
    assert.equal(
      databaseFailureOf(new Error(message))?.kind,
      'connection_lost',
    );
});
