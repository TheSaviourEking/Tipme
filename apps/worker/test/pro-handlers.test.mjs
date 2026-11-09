import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { handleProExpire, handleProReminders } from '../dist/handlers/pro.js';

// Paid Pro (ADR-0015): the expiry sweep every minute and the reminders every 15 minutes. The sweep
// itself has its own integration tests (pro-periods.test.mjs); these test the job around it.
const sealing = { key: Buffer.alloc(32) };

test('the jobs are scheduled and dispatched by name', () => {
  const source = readFileSync(
    new URL('../src/job-worker.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /PRO_EXPIRE_JOB = 'pro\.expire'/);
  assert.match(source, /PRO_REMINDERS_JOB = 'pro\.reminders'/);
  assert.match(source, /id: PRO_EXPIRE_JOB,\s+every: 60_000/);
  assert.match(source, /id: PRO_REMINDERS_JOB,\s+every: 15 \* 60_000/);
  assert.match(source, /job\.name === PRO_EXPIRE_JOB/);
  assert.match(source, /job\.name === PRO_REMINDERS_JOB/);
  assert.match(source, /proExpireSchedule\.stop\(\)/);
  assert.match(source, /proRemindersSchedule\.stop\(\)/);
});

test('expiry revalidates the handle and publishes profile.changed once per changed profile', async () => {
  const revalidated = [];
  const published = [];
  const outcome = await handleProExpire({
    db: {},
    sealing,
    now: () => new Date('2026-12-12T09:00:00Z'),
    revalidate: async (handle) => revalidated.push(handle),
    publishLive: async (messages) => published.push(...messages),
    expire: async () => ({
      moved: 3,
      changed: [
        { profileId: 'p1', handleLower: 'ada', plan: 'free' },
        { profileId: 'p2', handleLower: 'tobi', plan: 'pro' },
      ],
    }),
  });
  assert.equal(outcome, 'swept');
  assert.deepEqual(revalidated, ['ada', 'tobi']);
  assert.deepEqual(published, [
    { to: { profile: 'p1' }, type: 'profile.changed' },
    { to: { profile: 'p2' }, type: 'profile.changed' },
  ]);
});

test('nothing changed: nothing revalidated or published; no revalidator is fine', async () => {
  const published = [];
  await handleProExpire({
    db: {},
    sealing,
    now: () => new Date(),
    revalidate: null,
    publishLive: async (messages) => published.push(...messages),
    expire: async () => ({ moved: 0, changed: [] }),
  });
  assert.deepEqual(published, []);
});

test('reminders run the reminder sweep with the clock', async () => {
  const at = new Date('2026-12-02T09:00:00Z');
  let seen;
  const outcome = await handleProReminders({
    db: {},
    sealing,
    now: () => at,
    remind: async (_db, input) => {
      seen = input.now;
      return { queued: 2 };
    },
  });
  assert.equal(outcome, 'reminded');
  assert.equal(seen, at);
});
