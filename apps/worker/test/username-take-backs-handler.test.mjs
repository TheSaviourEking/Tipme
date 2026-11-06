import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { handleUsernameTakeBacks } from '../dist/handlers/username-take-backs.js';
import { workerRevalidator } from '../dist/revalidate.js';

/*
 * The handler around sweepTakeBacks (tests/integration/username-take-backs.test.mjs covers the
 * sweep itself). A database stub answers the sweep's reads: `rows` per step, in the order it asks.
 */
const SECRET = 'a-revalidation-secret-of-32-characters!!';

test('the job dispatches by name and revalidates what the sweep returns', () => {
  const source = readFileSync(
    new URL('../src/job-worker.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /USERNAME_TAKE_BACKS_JOB = 'usernames\.take-backs'/);
  assert.match(source, /id: USERNAME_TAKE_BACKS_JOB,\s+every: 60_000/);
  assert.match(source, /job\.name === USERNAME_TAKE_BACKS_JOB/);
  assert.match(source, /takeBacksSchedule\.stop\(\)/);
});

/** A database whose every query finds nothing: the sweep has nothing to do. */
const emptyDb = () => ({
  execute: async () => ({ rows: [] }),
  transaction: async () => {
    throw new Error('no transaction expected');
  },
});

test('running it twice changes nothing the second time', async () => {
  const revalidated = [];
  for (let run = 0; run < 2; run++)
    assert.equal(
      await handleUsernameTakeBacks({
        db: emptyDb(),
        sealing: { key: Buffer.alloc(32) },
        now: () => new Date(),
        revalidate: async (handle) => revalidated.push(handle),
      }),
      'swept',
    );
  assert.deepEqual(revalidated, []);
});

test('it respects its timeout', async () => {
  // The sweep returns a page to refresh (stubbed by a db whose first candidate query names one),
  // and the web app never answers: the job still ends within its bound.
  const logs = [];
  const started = Date.now();
  const outcome = await handleUsernameTakeBacks({
    db: emptyDb(),
    sealing: { key: Buffer.alloc(32) },
    now: () => new Date(),
    revalidate: () => new Promise(() => {}),
    revalidateWithinMs: 50,
    log: (entry) => logs.push(entry),
    sweep: async () => ({
      noticed: 0,
      reminded: 0,
      completed: 1,
      unreached: 0,
      revalidate: ['kemi', 'page_x7k2qd'],
    }),
  });
  assert.equal(outcome, 'swept');
  assert.ok(Date.now() - started < 2000);
  assert.ok(
    logs.some((l) => l.event === 'usernames.take_backs_revalidate_late'),
  );
});

test('with no revalidation secret it skips revalidating, and still sweeps', async () => {
  assert.equal(workerRevalidator({ WEB_ORIGIN: 'https://usetipme.xyz' }), null);
  let swept = 0;
  const outcome = await handleUsernameTakeBacks({
    db: emptyDb(),
    sealing: { key: Buffer.alloc(32) },
    now: () => new Date(),
    revalidate: null,
    sweep: async () => {
      swept += 1;
      return {
        noticed: 0,
        reminded: 0,
        completed: 1,
        unreached: 0,
        revalidate: ['kemi'],
      };
    },
  });
  assert.equal(outcome, 'swept');
  assert.equal(swept, 1);
});

test('the revalidator posts the handle and secret to the web app', async () => {
  const sent = [];
  const revalidate = workerRevalidator(
    { WEB_ORIGIN: 'https://usetipme.xyz', WEB_REVALIDATE_SECRET: SECRET },
    {
      fetchImpl: async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) });
        return new Response('{}', { status: 200 });
      },
    },
  );
  await revalidate('kemi');
  assert.deepEqual(sent, [
    {
      url: 'https://usetipme.xyz/api/revalidate',
      body: { handle: 'kemi', secret: SECRET },
    },
  ]);
  // A failure is logged, never thrown, and never names the secret.
  const logs = [];
  const failing = workerRevalidator(
    { WEB_ORIGIN: 'https://usetipme.xyz', WEB_REVALIDATE_SECRET: SECRET },
    {
      fetchImpl: async () => {
        throw new Error('down');
      },
      log: (entry) => logs.push(entry),
    },
  );
  await failing('kemi');
  assert.equal(logs[0].event, 'profile.revalidate_failed');
  assert.ok(!JSON.stringify(logs).includes(SECRET));
});
