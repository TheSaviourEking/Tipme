import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateWithRetry } from '../dist/migrate-retry.js';

// The release migration's retry, with the migration run and the clock stood in for. Errors are
// shaped like drizzle's: the driver error (with the SQLSTATE) is the cause.
const sqlError = (code) =>
  Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('driver'), { code }),
  });

function runner(outcomes) {
  let calls = 0;
  const run = async () => {
    const outcome = outcomes[calls++];
    if (outcome) throw outcome;
  };
  return { run, calls: () => calls };
}

function clock() {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

test('a deadlock (40P01) is retried after a wait, then succeeds', async () => {
  const { run, calls } = runner([sqlError('40P01'), null]);
  const { waits, sleep } = clock();
  const retries = [];
  await migrateWithRetry(run, {
    sleep,
    onRetry: (info) => retries.push(info),
  });
  assert.equal(calls(), 2);
  assert.deepEqual(waits, [5_000]);
  assert.deepEqual(retries, [
    { attempt: 1, sqlState: '40P01', delayMs: 5_000 },
  ]);
});

test('a lock timeout (55P03) is retried too, with a longer second wait', async () => {
  const { run, calls } = runner([sqlError('55P03'), sqlError('40P01'), null]);
  const { waits, sleep } = clock();
  await migrateWithRetry(run, { sleep });
  assert.equal(calls(), 3);
  assert.deepEqual(waits, [5_000, 15_000]);
});

test('any other error is thrown at once, never retried', async () => {
  for (const error of [
    sqlError('42601'), // syntax error
    sqlError('23505'), // unique violation
    sqlError('08006'), // connection failure
    new Error('no SQLSTATE at all'),
  ]) {
    const { run, calls } = runner([error, null]);
    const { waits, sleep } = clock();
    await assert.rejects(migrateWithRetry(run, { sleep }), (thrown) => {
      assert.equal(thrown, error);
      return true;
    });
    assert.equal(calls(), 1);
    assert.deepEqual(waits, []);
  }
});

test('gives up after three attempts and throws the last error', async () => {
  const last = sqlError('40P01');
  const { run, calls } = runner([sqlError('55P03'), sqlError('40P01'), last]);
  const { waits, sleep } = clock();
  await assert.rejects(migrateWithRetry(run, { sleep }), (thrown) => {
    assert.equal(thrown, last);
    return true;
  });
  assert.equal(calls(), 3);
  assert.deepEqual(waits, [5_000, 15_000]);
});

test('the attempt limit is configurable', async () => {
  const { run, calls } = runner([sqlError('40P01'), null]);
  await assert.rejects(
    migrateWithRetry(run, { attempts: 1, sleep: async () => {} }),
  );
  assert.equal(calls(), 1);
});
