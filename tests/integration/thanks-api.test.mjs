import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  WEB,
  browserHeaders,
  opsSignIn,
  signIn,
  startStack,
} from './helpers.mjs';

// "Make it yours": the thank-you line a supporter reads on their receipt (pretend payments only).
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let staff;
// One sign-in for the file: each sign-in sends a code, and a phone may only ask for a few.
let ada;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
  staff = await opsSignIn(stack.api, database.db, '+2348031270099');
  ada = await signIn(stack.api, ADA.phone);
});
after(async () => {
  await stack.stop();
  await database.close();
});

const ADA = DEMO_PROFILES[0];
const call = (method, path, cookie, body, headers) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers:
      headers ??
      (method === 'GET' ? (cookie ? { cookie } : {}) : browserHeaders(cookie)),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const errorOf = async (response) => (await response.json()).error;
const setPlan = async (plan) =>
  assert.equal(
    (
      await call('POST', `/v1/ops/pages/${ADA.id}/plan`, staff.cookie, {
        plan,
        reason: 'Thank-you line test',
      })
    ).status,
    200,
  );

/** A paid pretend tip to Ada; returns what the supporter's tab holds. */
async function paidTip() {
  const post = (path, body, headers = {}) =>
    fetch(`${stack.api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then((response) => response.json());
  const quote = await post('/v1/tip-quotes', {
    handle: 'ada',
    amountMinor: '200000',
    currency: 'NGN',
  });
  const intent = await post(
    '/v1/tip-intents',
    { quoteId: quote.data.quoteId },
    { 'idempotency-key': randomUUID() },
  );
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await post(`/v1/mock-provider/checkout/${reference}`, { outcome: 'succeed' });
  return intent.data;
}
const receipt = async ({ tipId, statusToken }) => {
  for (let i = 0; i < 50; i += 1) {
    const response = await fetch(`${stack.api}/v1/tips/${tipId}/status`, {
      headers: { authorization: `Bearer ${statusToken}` },
    });
    const { data } = await response.json();
    if (data?.state === 'paid') return data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('the tip never showed as paid');
};

test('PUT /v1/me/thanks saves a Free line and the receipt shows it after payment', async () => {
  const saved = await call('PUT', '/v1/me/thanks', ada.cookie, {
    line: '  Thank you   for backing my channel. ',
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).data.thanks, {
    line: 'Thank you for backing my channel.',
    style: 'paper',
    signed: false,
  });
  const tip = await paidTip();
  assert.deepEqual((await receipt(tip)).thanks, {
    line: 'Thank you for backing my channel.',
    style: 'paper',
  });
});

test('a Free page sending a style gets 403 THANKS_PRO_REQUIRED', async () => {
  for (const body of [
    { line: 'x', style: 'night' },
    { line: 'x', signed: true },
  ]) {
    const response = await call('PUT', '/v1/me/thanks', ada.cookie, body);
    assert.equal(response.status, 403);
    const error = await errorOf(response);
    assert.equal(error.code, 'THANKS_PRO_REQUIRED');
    assert.equal(
      error.message,
      'Card styles and your signature are part of TipMe Pro.',
    );
  }
});

test('a link or 141 characters is 400 VALIDATION_FAILED with fields ["line"]', async () => {
  for (const line of ['Find me at ada.com.ng', 'a'.repeat(141)]) {
    const response = await call('PUT', '/v1/me/thanks', ada.cookie, { line });
    assert.equal(response.status, 400);
    const error = await errorOf(response);
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.deepEqual(error.fields, ['line']);
    assert.doesNotMatch(JSON.stringify(error), /ada\.com\.ng/);
  }
});

test('Pro: night and signed show on the receipt with the first name; staff moving the page to Free hides them', async () => {
  await setPlan('pro');
  try {
    const saved = await call('PUT', '/v1/me/thanks', ada.cookie, {
      line: 'Thank you, truly.',
      style: 'night',
      signed: true,
    });
    assert.equal(saved.status, 200);
    const tip = await paidTip();
    assert.deepEqual((await receipt(tip)).thanks, {
      line: 'Thank you, truly.',
      style: 'night',
      signature: 'Ada',
    });
    await setPlan('free');
    assert.deepEqual((await receipt(tip)).thanks, {
      line: 'Thank you, truly.',
      style: 'paper',
    });
    // Kept for when the page is Pro again.
    const mine = (
      await (await call('GET', '/v1/me/profile', ada.cookie)).json()
    ).data;
    assert.deepEqual(mine.thanks, {
      line: 'Thank you, truly.',
      style: 'night',
      signed: true,
    });
  } finally {
    await setPlan('free');
  }
});

test('without a session or CSRF the route is refused', async () => {
  const anonymous = await call('PUT', '/v1/me/thanks', undefined, {
    line: 'x',
  });
  assert.equal(anonymous.status, 401);
  const noCsrf = await call(
    'PUT',
    '/v1/me/thanks',
    ada.cookie,
    { line: 'x' },
    { 'content-type': 'application/json', cookie: ada.cookie },
  );
  assert.equal(noCsrf.status, 403);
});
