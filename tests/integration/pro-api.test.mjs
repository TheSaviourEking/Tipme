import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Paid Pro, plan Task 6 (ADR-0015): buying a month on pretend money through the API. The price is
// the server's; Pro comes only from the partner's confirmation, never from a redirect.

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let off;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  const apiEnv = { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' };
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { ...apiEnv, PRO_BILLING_ENABLED: 'true' },
  });
  off = await startStack({ databaseUrl: database.url, apiEnv });
});
after(async () => {
  await off.stop();
  await stack.stop();
  await database.close();
});

const sessions = new Map();
const session = (phone) => {
  if (!sessions.has(phone)) sessions.set(phone, signIn(stack.api, phone));
  return sessions.get(phone);
};
const ADA_PHONE = '+2348000000001';
const TOBI_PHONE = '+2348000000002';
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

const buy = async (
  api,
  cookie,
  body = { expectedAmountMinor: '500000' },
  key = randomUUID(),
) =>
  fetch(`${api}/v1/me/pro/purchases`, {
    method: 'POST',
    headers: browserHeaders(cookie, { 'idempotency-key': key }),
    body: JSON.stringify(body),
  });

const texts = [];
const json = async (response) => {
  const text = await response.text();
  texts.push(text);
  return JSON.parse(text);
};

test('buying needs a session, the CSRF header and an Idempotency-Key', async () => {
  const { cookie } = await session(TOBI_PHONE);
  const anonymous = await fetch(`${stack.api}/v1/me/pro/purchases`, {
    method: 'POST',
    headers: browserHeaders(undefined, { 'idempotency-key': randomUUID() }),
    body: JSON.stringify({ expectedAmountMinor: '500000' }),
  });
  assert.equal(anonymous.status, 401);
  const noCsrf = await fetch(`${stack.api}/v1/me/pro/purchases`, {
    method: 'POST',
    headers: {
      origin: WEB,
      'content-type': 'application/json',
      cookie,
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ expectedAmountMinor: '500000' }),
  });
  assert.equal(noCsrf.status, 403);
  const noKey = await fetch(`${stack.api}/v1/me/pro/purchases`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ expectedAmountMinor: '500000' }),
  });
  assert.equal(noKey.status, 400);
  // The client can't name a price of its own: only an expected amount, checked against the server.
  const extra = await buy(stack.api, cookie, {
    expectedAmountMinor: '500000',
    amountMinor: '100',
  });
  assert.equal(extra.status, 400);
});

test('with PRO_BILLING_ENABLED off, buying is 404 PRO_BILLING_OFF and GET says billing is off', async () => {
  // Sessions live in the shared database: the same cookie signs in to both copies.
  const { cookie } = await session(TOBI_PHONE);
  const response = await buy(off.api, cookie);
  assert.equal(response.status, 404);
  assert.equal((await json(response)).error.code, 'PRO_BILLING_OFF');
  const mine = await json(
    await fetch(`${off.api}/v1/me/pro`, { headers: { cookie } }),
  );
  assert.equal(mine.data.billingOn, false);
});

test('GET /v1/pro/price tells a signed-out visitor whether buying is open on this copy', async () => {
  // The /pro page shows "Get Pro" or "coming soon to buy" before anyone signs in.
  for (const [api, open] of [
    [stack.api, true],
    [off.api, false],
  ]) {
    const response = await fetch(`${api}/v1/pro/price`, {
      headers: { origin: WEB },
    });
    // The page reads it from the browser: the web app may, with no cookie.
    assert.equal(response.headers.get('access-control-allow-origin'), WEB);
    assert.equal(
      response.headers.get('access-control-allow-credentials'),
      null,
    );
    const { data } = await json(response);
    assert.equal(data.amountMinor, '500000');
    assert.equal(data.billingOn, open);
  }
});

test('GET /v1/me/pro shows the server’s price, card only while paying from the balance is off', async () => {
  const { cookie } = await session(TOBI_PHONE);
  const response = await fetch(`${stack.api}/v1/me/pro`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const { data } = await json(response);
  assert.deepEqual(data.price, {
    amountMinor: '500000',
    currency: 'NGN',
    interval: 'month',
  });
  assert.deepEqual(data.methods, ['card']);
  assert.equal(data.billingOn, true);
  assert.equal(data.plan, 'free');
  assert.equal(data.source, null);
});

test('an expected amount other than the price is 409 PRO_PRICE_CHANGED', async () => {
  const { cookie } = await session(TOBI_PHONE);
  const response = await buy(stack.api, cookie, {
    expectedAmountMinor: '200000',
  });
  assert.equal(response.status, 409);
  assert.equal((await json(response)).error.code, 'PRO_PRICE_CHANGED');
});

test('pretend money end to end: open, a redirect changes nothing, pay on the pretend checkout, Pro', async () => {
  const { cookie } = await session(ADA_PHONE);
  const key = randomUUID();
  const opened = await buy(stack.api, cookie, undefined, key);
  assert.equal(opened.status, 201);
  const { data: purchase } = await json(opened);
  assert.equal(purchase.status, 'PENDING');
  assert.equal(purchase.amountMinor, '500000');
  assert.match(
    purchase.checkoutUrl,
    /^http:\/\/localhost:3000\/mock-checkout\/mock_pro_/,
  );
  // The same key again: the same purchase.
  const again = await json(await buy(stack.api, cookie, undefined, key));
  assert.equal(again.data.purchaseId, purchase.purchaseId);
  // A second purchase while this one is open is refused.
  const second = await buy(stack.api, cookie);
  assert.equal(second.status, 409);
  assert.equal((await json(second)).error.code, 'PRO_PURCHASE_OPEN');

  // Coming back from the checkout proves nothing: the purchase and plan are unchanged.
  const status = await json(
    await fetch(`${stack.api}/v1/me/pro/purchases/${purchase.purchaseId}`, {
      headers: { cookie },
    }),
  );
  assert.equal(status.data.status, 'PENDING');
  assert.equal(
    (await q(`SELECT plan FROM profiles WHERE handle = 'ada'`))[0].plan,
    'free',
  );

  // The pretend partner's page: pay by bank transfer.
  const reference = purchase.checkoutUrl.split('/').at(-1);
  const summary = await json(
    await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`),
  );
  assert.equal(summary.data.amountMinor, '500000');
  const paid = await fetch(
    `${stack.api}/v1/mock-provider/checkout/${reference}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'succeed', method: 'bank_transfer' }),
    },
  );
  assert.equal(paid.status, 201);
  assert.match((await json(paid)).data.returnUrl, /\/dashboard\/settings/);

  const after = await json(
    await fetch(`${stack.api}/v1/me/pro/purchases/${purchase.purchaseId}`, {
      headers: { cookie },
    }),
  );
  assert.equal(after.data.status, 'PAID');
  const mine = await json(
    await fetch(`${stack.api}/v1/me/pro`, { headers: { cookie } }),
  );
  assert.equal(mine.data.plan, 'pro');
  assert.equal(mine.data.source, 'paid');
  assert.equal(mine.data.current.paidBy, 'bank_transfer');
  assert.ok(Date.parse(mine.data.current.endsAt) > Date.now());
  assert.ok(
    Date.parse(mine.data.current.graceEndsAt) >
      Date.parse(mine.data.current.endsAt),
  );
  assert.equal(mine.data.openPurchase, null);
  const [booked] = await q(
    `SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_key = $1`,
    [`pro.${purchase.purchaseId}`],
  );
  assert.equal(booked.n, 1);
});

test('another person’s purchase is not found', async () => {
  const ada = await session(ADA_PHONE);
  const tobi = await session(TOBI_PHONE);
  const { data } = await json(await buy(stack.api, tobi.cookie));
  const peek = await fetch(
    `${stack.api}/v1/me/pro/purchases/${data.purchaseId}`,
    { headers: { cookie: ada.cookie } },
  );
  assert.equal(peek.status, 404);
});

test('no answer names the payment partner', () => {
  assert.ok(texts.length > 5);
  for (const text of texts) assert.doesNotMatch(text, /bachs/i);
});
