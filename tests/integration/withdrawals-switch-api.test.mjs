import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { handleWithdrawalsSwitchChanged } from '../../apps/worker/dist/handlers/withdrawals-switch.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const REASON = 'A wrong payout amount: stopping while we look.';
let database;
let first;
let second;
let owner;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  const apiEnv = { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' };
  first = await startStack({ databaseUrl: database.url, apiEnv });
  second = await startStack({ databaseUrl: database.url, apiEnv });
  owner = await opsSignIn(first.api, database.db, '+2348031110031');
});
after(async () => {
  await second.stop();
  await first.stop();
  await database.close();
});

const set = (paused, cookie = owner.cookie, reason = REASON) =>
  fetch(`${first.api}/v1/ops/withdrawals-switch`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ paused, reason }),
  });
const metrics = async (api) =>
  (
    await (
      await fetch(`${api}/v1/ops/metrics/health`, {
        headers: { cookie: owner.cookie },
      })
    ).json()
  ).data.metrics;

test('permission and a written reason are required', async () => {
  assert.equal((await set(true, '')).status, 404);
  const person = await signIn(first.api, '+2348031110032');
  assert.equal((await set(true, person.cookie)).status, 404);
  assert.equal((await set(true, owner.cookie, 'short')).status, 400);
  // An owner holds the whole catalogue, whatever is stored: move them to a role without it.
  await database.pool.query(
    `INSERT INTO roles (id, name) VALUES ('no_payouts', 'No payouts') ON CONFLICT DO NOTHING`,
  );
  await database.pool.query(
    `UPDATE staff SET role_id = 'no_payouts' WHERE role_id = 'owner'`,
  );
  try {
    assert.equal((await set(true)).status, 403);
  } finally {
    await database.pool.query(
      `UPDATE staff SET role_id = 'owner' WHERE role_id = 'no_payouts'`,
    );
  }
  assert.equal((await metrics(first.api)).withdrawalsSwitch.paused, false);
});

test('a change made on one API copy applies on another at its next request, and refuses a withdrawal there', async () => {
  const person = await signIn(second.api, '+2348000000002');
  assert.equal((await set(true)).status, 200);
  assert.equal((await metrics(second.api)).withdrawalsSwitch.paused, true);
  const quote = await (
    await fetch(`${second.api}/v1/me/withdrawal-quote`, {
      headers: { cookie: person.cookie },
    })
  ).json();
  assert.equal(quote.data.state, 'paused');
  assert.equal(quote.data.reason, 'switched_off');
  const refused = await fetch(`${second.api}/v1/me/withdrawals`, {
    method: 'POST',
    headers: {
      ...browserHeaders(person.cookie),
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ amountMinor: '100000' }),
  });
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.error.code, 'WITHDRAWALS_SWITCHED_OFF');
  assert.equal(
    body.error.message,
    'Withdrawals are paused for now. Your balance is safe.',
  );
  assert.equal((await set(false)).status, 200);
  assert.equal((await metrics(second.api)).withdrawalsSwitch.paused, false);
});

test('the alert goes through the route in plain words, and fails so the job retries; no route is logged', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body).text);
    return new Response('{}', { status: 200 });
  };
  await handleWithdrawalsSwitchChanged(
    { state: 'off' },
    { url: 'https://hooks.example.test/x', fetchImpl },
  );
  await handleWithdrawalsSwitchChanged(
    { state: 'on' },
    { url: 'https://hooks.example.test/x', fetchImpl },
  );
  assert.match(sent[0], /Withdrawals were switched OFF/);
  assert.match(sent[1], /Withdrawals were switched back ON/);
  await assert.rejects(
    handleWithdrawalsSwitchChanged(
      { state: 'off' },
      {
        url: 'https://hooks.example.test/x',
        fetchImpl: async () => new Response('', { status: 500 }),
      },
    ),
  );
  const logged = [];
  assert.equal(
    await handleWithdrawalsSwitchChanged(
      { state: 'off' },
      { url: undefined, log: (entry) => logged.push(entry) },
    ),
    'unrouted',
  );
  assert.equal(logged.length, 1);
});
