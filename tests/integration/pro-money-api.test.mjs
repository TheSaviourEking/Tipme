import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import {
  DEMO_PROFILES,
  grantCashReward,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Paid Pro, plan Tasks 8 and 10 through the API, on pretend money: paying from the TipMe balance
// (PRO_PAY_FROM_BALANCE) and auto-renew (PRO_AUTO_RENEW), both off by default.

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let on;
let plain;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  const apiEnv = {
    WEB_ORIGIN: WEB,
    RATE_LIMIT_AUTH_PER_HOUR: '1000',
    PRO_BILLING_ENABLED: 'true',
  };
  on = await startStack({
    databaseUrl: database.url,
    apiEnv: { ...apiEnv, PRO_PAY_FROM_BALANCE: 'on', PRO_AUTO_RENEW: 'on' },
  });
  plain = await startStack({ databaseUrl: database.url, apiEnv });
});
after(async () => {
  await plain.stop();
  await on.stop();
  await database.close();
});

const [ADA] = DEMO_PROFILES;
const ADA_PHONE = '+2348000000001';
let adaSession;
const ada = () => (adaSession ??= signIn(on.api, ADA_PHONE));
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const texts = [];
const json = async (response) => {
  const text = await response.text();
  texts.push(text);
  return JSON.parse(text);
};
const buy = (api, cookie, body) =>
  fetch(`${api}/v1/me/pro/purchases`, {
    method: 'POST',
    headers: browserHeaders(cookie, { 'idempotency-key': randomUUID() }),
    body: JSON.stringify({ expectedAmountMinor: '500000', ...body }),
  });
const reset = async () => {
  await q(`DELETE FROM pro_periods`);
  await q(
    `UPDATE pro_purchases SET status = 'FAILED' WHERE status IN ('PENDING','COLLECTING','UNKNOWN')`,
  );
};

test('by default: card only, no auto-renew, and asking for either is refused', async () => {
  const { cookie } = await ada();
  const mine = await json(
    await fetch(`${plain.api}/v1/me/pro`, { headers: { cookie } }),
  );
  assert.deepEqual(mine.data.methods, ['card']);
  assert.deepEqual(mine.data.autoRenew, { available: false, on: false });
  assert.equal(
    (await buy(plain.api, cookie, { method: 'balance' })).status,
    400,
  );
  assert.equal((await buy(plain.api, cookie, { autoRenew: true })).status, 400);
  assert.equal((await q(`SELECT 1 FROM pro_purchases`)).length, 0);
});

test('switched on: the balance is offered, and a balance payment makes the page Pro at once', async () => {
  await reset();
  const { cookie } = await ada();
  await grantCashReward(database.db, {
    profileId: ADA.id,
    amountMinor: 900000n,
    currency: 'NGN',
    operationKey: `reward.api.${randomUUID()}`,
  });
  const mine = await json(
    await fetch(`${on.api}/v1/me/pro`, { headers: { cookie } }),
  );
  assert.deepEqual(mine.data.methods, ['card', 'balance']);
  assert.equal(mine.data.autoRenew.available, true);
  const response = await buy(on.api, cookie, { method: 'balance' });
  assert.equal(response.status, 201);
  const bought = await json(response);
  assert.equal(bought.data.status, 'PAID');
  assert.equal(bought.data.checkoutUrl, null);
  const [page] = await q(`SELECT plan FROM profiles WHERE id = $1`, [ADA.id]);
  assert.equal(page.plan, 'pro');
});

test('a balance payment with auto-renew is refused: auto-renew is a card opt-in', async () => {
  await reset();
  const { cookie } = await ada();
  assert.equal(
    (await buy(on.api, cookie, { method: 'balance', autoRenew: true })).status,
    400,
  );
});

test('a card checkout with auto-renew ticked saves the card on a customer; turning it off always works', async () => {
  await reset();
  const { cookie } = await ada();
  await q(
    `UPDATE users SET email = 'ada@example.com', email_verified_at = now()
       WHERE id = (SELECT user_id FROM profiles WHERE id = $1)`,
    [ADA.id],
  );
  const response = await buy(on.api, cookie, { autoRenew: true });
  assert.equal(response.status, 201);
  const bought = await json(response);
  assert.equal(bought.data.status, 'PENDING');
  const [row] = await q(`SELECT save_card FROM pro_purchases WHERE id = $1`, [
    bought.data.purchaseId,
  ]);
  assert.equal(row.save_card, true);
  const [renew] = await q(
    `SELECT enabled, customer_reference FROM pro_auto_renew WHERE profile_id = $1`,
    [ADA.id],
  );
  assert.ok(renew.customer_reference);
  // Off on a copy where auto-renew isn't even offered: it must still work.
  const off = await fetch(`${plain.api}/v1/me/pro/auto-renew/off`, {
    method: 'POST',
    headers: browserHeaders(cookie),
  });
  assert.equal(off.status, 200);
  assert.deepEqual((await json(off)).data, { on: false });
});

test('no answer names the payment partner', () => {
  for (const text of texts) assert.doesNotMatch(text, /bachs/i);
});
