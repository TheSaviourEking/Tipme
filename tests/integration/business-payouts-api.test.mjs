import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
  markAttemptInitiated,
  recordProviderEvent,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedManager,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import {
  WEB,
  browserHeaders,
  signIn,
  startStack,
  uniquePrefix,
} from './helpers.mjs';

// Business release 2, PR R2-B: a business's balance, bank and withdrawals over HTTP. Owners only;
// anyone else reads 404 as for an unknown business. Pretend payouts only.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const [ADA, TOBI] = DEMO_PROFILES;
const GROSS = 4000000n;
const BPS = 5000;
let database;
let stack;
let ada;
let tobi;
let shared;
let share;

const q = (sql, params) => database.pool.query(sql, params).then((r) => r.rows);

/** A paid tip to Tobi at the business, with its share fixed at intent time. */
async function paidSharedTip() {
  const { db } = database;
  const quote = await createQuote(db, {
    handle: 'tobi',
    tipMinor: GROSS,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    businessMemberId: shared.memberId,
  });
  const [{ net }] = await q(
    `SELECT q.recipient_net_minor::text AS net FROM tips t JOIN payment_intents i ON i.id = t.intent_id
       JOIN tip_quotes q ON q.id = i.quote_id WHERE t.id = $1`,
    [intent.tipId],
  );
  const part = (BigInt(net) * BigInt(BPS)) / 10000n;
  await q(
    `INSERT INTO tip_business_shares (tip_id, agreement_id, business_id, business_bps, share_minor)
     VALUES ($1, $2, $3, $4, $5)`,
    [intent.tipId, shared.agreementId, shared.businessId, BPS, part.toString()],
  );
  const reference = `mock_pay_${randomUUID()}`;
  await markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await recordProviderEvent(db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: GROSS,
    currency: 'NGN',
    providerFeeMinor: 6000n,
    signatureVerified: true,
    payload: {},
  });
  return part;
}

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      BUSINESS_ENABLED: 'true',
      BUSINESS_SHARES_ENABLED: 'true',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
    },
  });
  ada = await signIn(stack.api, ADA.phone);
  tobi = await signIn(stack.api, TOBI.phone);
  const { businessId, locations } = await seedBusiness(database);
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI.id,
  });
  const { agreementId } = await seedAgreement(database, {
    memberId,
    businessBps: BPS,
  });
  // Tobi also runs the location: a manager, but not an owner.
  await seedManager(database, {
    businessId,
    userId: TOBI.userId,
    locationId: locations[0].id,
  });
  shared = { businessId, memberId, agreementId };
  share = await paidSharedTip();
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const call = async (method, path, { cookie, body, headers } = {}) => {
  const response = await fetch(`${stack.api}${path}`, {
    method,
    headers: headers ?? browserHeaders(cookie),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
const base = () => `/v1/me/businesses/${shared.businessId}`;

test('without a session every route is 401', async () => {
  for (const [method, path] of [
    ['GET', '/balance'],
    ['GET', '/withdrawal-quote'],
    ['GET', '/payout-destination'],
    ['POST', '/withdrawals'],
  ])
    assert.equal((await call(method, `${base()}${path}`)).status, 401, path);
});

test('an owner reads the business balance from its share lines', async () => {
  const { status, body } = await call('GET', `${base()}/balance`, {
    cookie: ada.cookie,
  });
  assert.equal(status, 200);
  assert.deepEqual(body.data, {
    businessId: shared.businessId,
    currency: 'NGN',
    balanceMinor: share.toString(),
    canWithdraw: true,
  });
  const quote = await call('GET', `${base()}/withdrawal-quote`, {
    cookie: ada.cookie,
  });
  assert.equal(quote.status, 200);
  assert.equal(quote.body.data.state, 'ready');
  assert.equal(quote.body.data.ledgerMinor, share.toString());
  assert.equal(quote.body.data.inReview, false);
});

test('a location manager, or someone else, sees nothing of the money: 404', async () => {
  for (const [method, path, body] of [
    ['GET', '/balance'],
    ['GET', '/withdrawal-quote'],
    ['GET', '/payout-destination'],
    ['POST', '/payout-destination/code'],
    ['POST', '/withdrawals', { amountMinor: '200000' }],
  ]) {
    const response = await call(method, `${base()}${path}`, {
      cookie: tobi.cookie,
      body,
      headers: {
        ...browserHeaders(tobi.cookie),
        'idempotency-key': randomUUID(),
      },
    });
    assert.equal(response.status, 404, path);
    assert.equal(response.body.error.code, 'BUSINESS_NOT_FOUND', path);
  }
  const unknown = await call(
    'GET',
    `/v1/me/businesses/${randomUUID()}/balance`,
    { cookie: ada.cookie },
  );
  assert.equal(unknown.status, 404);
  assert.equal(
    (
      await q('SELECT id FROM payouts WHERE business_id = $1', [
        shared.businessId,
      ])
    ).length,
    0,
  );
});

test('an owner withdraws: CSRF and a key are required, a retry replays, too much is refused', async () => {
  const path = `${base()}/withdrawals`;
  const body = { amountMinor: '200000' };
  const noCsrf = await call('POST', path, {
    body,
    headers: {
      'content-type': 'application/json',
      cookie: ada.cookie,
      'idempotency-key': randomUUID(),
    },
  });
  assert.equal(noCsrf.status, 403);
  const noKey = await call('POST', path, { cookie: ada.cookie, body });
  assert.equal(noKey.status, 400);
  const key = randomUUID();
  const headers = { ...browserHeaders(ada.cookie), 'idempotency-key': key };
  const first = await call('POST', path, { body, headers });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.status, 'REQUESTED');
  const again = await call('POST', path, { body, headers });
  assert.equal(again.body.data.payoutId, first.body.data.payoutId);
  const [row] = await q(
    `SELECT business_id, profile_id, amount_minor::text AS amount, user_fee_minor::text AS fee
       FROM payouts WHERE id = $1`,
    [first.body.data.payoutId],
  );
  // The business pays the ₦50 transfer fee from the amount (owner, 12 Nov 2026).
  assert.deepEqual(row, {
    business_id: shared.businessId,
    profile_id: null,
    amount: '195000',
    fee: '5000',
  });
  const tooMuch = await call('POST', path, {
    body: { amountMinor: share.toString() },
    headers: { ...browserHeaders(ada.cookie), 'idempotency-key': randomUUID() },
  });
  assert.equal(tooMuch.status, 409);
  assert.equal(tooMuch.body.error.code, 'INSUFFICIENT_BALANCE');
  // Tobi's own balance never held the business's share.
  const mine = await call('GET', '/v1/me/dashboard', { cookie: tobi.cookie });
  assert.equal(mine.status, 200);
  const [{ net }] = await q(
    `SELECT sum(q.recipient_net_minor)::text AS net FROM tips t JOIN payment_intents i ON i.id = t.intent_id
       JOIN tip_quotes q ON q.id = i.quote_id WHERE t.profile_id = $1 AND t.status = 'SUCCEEDED'`,
    [TOBI.id],
  );
  assert.equal(mine.body.data.availableMinor, (BigInt(net) - share).toString());
});

test("an owner sets the business's bank with a code sent to their own address", async () => {
  const email = `a@${uniquePrefix()}.example`;
  await q(
    'UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2',
    [email, ADA.userId],
  );
  const [local, domain] = email.split('@');
  const hint = `${local[0]}•••@${domain}`;
  const nextCode = async () => {
    for (let i = 0; i < 100; i++) {
      const { data } = await (await fetch(`${stack.api}/v1/dev/inbox`)).json();
      const mail = data.find(
        (m) =>
          m.to === hint && m.subject?.toLowerCase().includes('bank account'),
      );
      if (mail) return /\b(\d{6})\b/.exec(mail.body)[1];
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('no code arrived');
  };
  const banks = await call('GET', '/v1/payout-banks', { cookie: ada.cookie });
  const [bank] = banks.body.data;
  const resolved = await call('POST', `${base()}/payout-destination/resolve`, {
    cookie: ada.cookie,
    body: { bankCode: bank.code, accountNumber: '0123456789' },
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.data.resolved, true);
  assert.equal(
    (
      await call('POST', `${base()}/payout-destination/code`, {
        cookie: ada.cookie,
      })
    ).status,
    202,
  );
  const wrong = await call('PUT', `${base()}/payout-destination`, {
    cookie: ada.cookie,
    body: {
      bankCode: bank.code,
      accountNumber: '0123456789',
      accountName: 'PRETEND ACCOUNT HOLDER',
      emailCode: '000000',
    },
  });
  assert.equal(wrong.status, 400);
  // The wrong code spent nothing but itself; the real one still works.
  const put = await call('PUT', `${base()}/payout-destination`, {
    cookie: ada.cookie,
    body: {
      bankCode: bank.code,
      accountNumber: '0123456789',
      accountName: 'PRETEND ACCOUNT HOLDER',
      emailCode: await nextCode(),
    },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.data, {
    status: 'usable',
    bankName: bank.name,
    last4: '6789',
  });
  const read = await call('GET', `${base()}/payout-destination`, {
    cookie: ada.cookie,
  });
  assert.deepEqual(read.body.data.destination, put.body.data);
  // Ada's own page has no bank from this.
  assert.equal(
    (
      await q('SELECT id FROM payout_destinations WHERE profile_id = $1', [
        ADA.id,
      ])
    ).length,
    0,
  );
  const quote = await call('GET', `${base()}/withdrawal-quote`, {
    cookie: ada.cookie,
  });
  assert.deepEqual(quote.body.data.destination, {
    bankName: bank.name,
    last4: '6789',
  });
});
