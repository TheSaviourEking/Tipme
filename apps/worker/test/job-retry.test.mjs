import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistenceError } from '@tipme/database';
import { UnrecoverableError } from 'bullmq';
import { databaseFailureFields, jobFailure } from '../dist/job-retry.js';

const full = Object.assign(new Error('sorry, too many clients'), {
  code: '53300',
});

test('the database being unavailable earns another try', () => {
  for (const error of [
    full,
    new PersistenceError('53300', { kind: 'sqlstate', sqlState: '53300' }),
    new Error('timeout exceeded when trying to connect'),
    new Error('Connection terminated unexpectedly'),
    new Error('Client has encountered a connection error and is not queryable'),
  ])
    assert.equal(jobFailure('tip.succeeded', error), error);
});

test('anything else fails once, as before', () => {
  for (const error of [
    new TypeError('bug'),
    // An alert webhook's network failure is not the database's.
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
    }),
    new PersistenceError('23505', { kind: 'sqlstate', sqlState: '23505' }),
    new PersistenceError(undefined, {
      kind: 'unknown',
      causeName: 'TypeError',
    }),
  ])
    assert.ok(jobFailure('payout.start', error) instanceof UnrecoverableError);
});

test('the queue test probe keeps its own retries', () => {
  const error = new Error('probe_failure');
  assert.equal(jobFailure('diagnostics.trace-probe', error), error);
});

test('log fields carry codes, never the message', () => {
  assert.deepEqual(databaseFailureFields(full), {
    db_failure: 'sqlstate',
    sql_state: '53300',
  });
  assert.deepEqual(databaseFailureFields(new Error('other')), {});
});
