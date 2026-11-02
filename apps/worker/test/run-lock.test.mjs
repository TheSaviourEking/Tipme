import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runUnlessRunning } from '../dist/run-lock.js';

/** The two Redis commands the lock uses, in memory (expiry is not modelled). */
function fakeRedis() {
  const values = new Map();
  return {
    values,
    async set(key, value, _px, _ms, _nx) {
      if (values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async eval(_script, _count, key, token) {
      if (values.get(key) === token) {
        values.delete(key);
        return 1;
      }
      return 0;
    },
  };
}

const gate = () => {
  let open;
  const opened = new Promise((resolve) => (open = resolve));
  return { opened, open };
};

test('a run that starts while another is still going is skipped', async () => {
  const redis = fakeRedis();
  const first = gate();
  let ran = 0;
  const slow = runUnlessRunning(redis, { key: 'k', ttlMs: 1000 }, async () => {
    ran += 1;
    await first.opened;
    return 'done';
  });
  await new Promise((resolve) => setImmediate(resolve));
  const overlapping = await runUnlessRunning(
    redis,
    { key: 'k', ttlMs: 1000 },
    async () => {
      ran += 1;
      return 'second';
    },
  );
  assert.deepEqual(overlapping, { ran: false });
  first.open();
  assert.deepEqual(await slow, { ran: true, value: 'done' });
  assert.equal(ran, 1);
  // Finished: the next run goes ahead.
  assert.deepEqual(
    await runUnlessRunning(
      redis,
      { key: 'k', ttlMs: 1000 },
      async () => 'next',
    ),
    { ran: true, value: 'next' },
  );
});

test('the lock is released when the run fails, and the failure is passed on', async () => {
  const redis = fakeRedis();
  await assert.rejects(
    () =>
      runUnlessRunning(redis, { key: 'k', ttlMs: 1000 }, async () => {
        throw new Error('boom');
      }),
    { message: 'boom' },
  );
  assert.equal(redis.values.size, 0);
});

test('a run never releases a lock that someone else holds now', async () => {
  const redis = fakeRedis();
  await runUnlessRunning(redis, { key: 'k', ttlMs: 1000 }, async () => {
    // The lock expired mid-run and another worker took it.
    redis.values.set('k', 'someone-else');
  });
  assert.equal(redis.values.get('k'), 'someone-else');
});

test('different keys do not block each other', async () => {
  const redis = fakeRedis();
  const hold = gate();
  const a = runUnlessRunning(
    redis,
    { key: 'a', ttlMs: 1000 },
    () => hold.opened,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await runUnlessRunning(redis, { key: 'b', ttlMs: 1000 }, async () => 1),
    { ran: true, value: 1 },
  );
  hold.open();
  await a;
});
