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
import { lagosWeekOf } from '../../packages/domain/dist/index.js';
import {
  seedBusiness,
  seedManager,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// TipMe for businesses, PR B7: what the business sees, through the API. The database test proves
// every rule; this one proves the routes: who may read, CSRF, bad weeks, and nothing private.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const [ADA, TOBI] = DEMO_PROFILES;
let database;
let stack;
let ada;
let tobi;
let business;
let tobiMember;
const tips = [];
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      BUSINESS_ENABLED: 'true',
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
  ada = await signIn(stack.api, ADA.phone);
  tobi = await signIn(stack.api, TOBI.phone);
  // Ada owns The Yellow Chilli (VI and Ikoyi); Tobi works at VI.
  business = await seedBusiness(database, {
    locations: [
      { slug: 'vi', name: 'Victoria Island' },
      { slug: 'ikoyi', name: 'Ikoyi' },
    ],
  });
  ({ memberId: tobiMember } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: TOBI.id,
  }));
  // Three paid tips at VI, each with a supporter's name and a private message.
  for (let i = 0; i < 3; i += 1) tips.push(await payWithDetails());
  for (const tip of tips)
    await database.pool.query(
      `INSERT INTO business_notes (tip_id, member_id, tags, body) VALUES ($1, $2, '{friendly}', 'Kind and quick')`,
      [tip.tipId, tobiMember],
    );
});
after(async () => {
  await stack.stop();
  await database.close();
});

/** A paid pretend tip at Tobi's VI membership, with a supporter's name and message. */
async function payWithDetails() {
  const post = async (path, body, headers = {}) =>
    (
      await fetch(`${stack.api}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    ).json();
  const quote = await post('/v1/tip-quotes', {
    handle: 'tobi',
    amountMinor: '234500',
    currency: 'NGN',
  });
  const intent = await post(
    '/v1/tip-intents',
    {
      quoteId: quote.data.quoteId,
      businessMemberId: tobiMember,
      payerDisplayLabel: 'Chioma Secretname',
      message: 'secret private words',
    },
    { 'idempotency-key': randomUUID() },
  );
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await post(`/v1/mock-provider/checkout/${reference}`, { outcome: 'succeed' });
  return { tipId: intent.data.tipId, reference };
}

const week = () => lagosWeekOf(new Date());
const read = async (what, cookie, { locationId, w = week(), id } = {}) => {
  const params = new URLSearchParams({
    locationId: locationId ?? business.locations[0].id,
    week: w,
  });
  const response = await fetch(
    `${stack.api}/v1/me/businesses/${id ?? business.businessId}/${what}?${params}`,
    { headers: cookie ? { cookie } : {} },
  );
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: await response.json(),
  };
};
const share = (cookie, memberId, body, headers) =>
  fetch(`${stack.api}/v1/me/work/${memberId}/share-amounts`, {
    method: 'PATCH',
    headers: headers ?? browserHeaders(cookie),
    body: JSON.stringify(body),
  });

test('without a session both reads are 401', async () => {
  for (const what of ['insights', 'notes'])
    assert.equal((await read(what)).status, 401);
});

test('the owner reads the week: counts, notes, no amounts, never cached', async () => {
  const insights = await read('insights', ada.cookie);
  assert.equal(insights.status, 200);
  assert.equal(insights.cache, 'private, no-store');
  assert.deepEqual(insights.body.data.tips, { n: 3 });
  assert.equal(insights.body.data.people.length, 1);
  assert.equal(insights.body.data.people[0].shownName, 'Tobi');
  assert.equal(insights.body.data.people[0].amountMinor, undefined);
  const notes = await read('notes', ada.cookie);
  assert.equal(notes.status, 200);
  assert.equal(notes.cache, 'private, no-store');
  assert.equal(notes.body.data.length, 3);
  assert.equal(notes.body.data[0].body, 'Kind and quick');
});

test('no response carries the supporter’s name, message, a time, a tip id or a reference', async () => {
  const json = JSON.stringify([
    (await read('insights', ada.cookie)).body,
    (await read('notes', ada.cookie)).body,
  ]);
  assert.doesNotMatch(json, /Secretname/);
  assert.doesNotMatch(json, /secret private words/);
  assert.doesNotMatch(json, /\d{2}:\d{2}/);
  assert.doesNotMatch(json, /234500/);
  for (const tip of tips) {
    assert.doesNotMatch(json, new RegExp(tip.tipId));
    assert.doesNotMatch(json, new RegExp(tip.reference));
  }
});

test('a bad or missing week, or a bad location id, is a validation error', async () => {
  for (const w of ['2026-W54', '2026-W00', 'last week']) {
    const { status, body } = await read('insights', ada.cookie, { w });
    assert.equal(status, 400, w);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.deepEqual(body.error.fields, ['week']);
  }
  const { status } = await read('notes', ada.cookie, {
    locationId: 'not-a-uuid',
  });
  assert.equal(status, 400);
});

test('another business, a location of another business, or one a location manager doesn’t manage: 404', async () => {
  const other = await seedBusiness(database, { owner: TOBI.userId });
  for (const what of ['insights', 'notes']) {
    // Ada doesn't manage Tobi's business.
    let answer = await read(what, ada.cookie, {
      id: other.businessId,
      locationId: other.locations[0].id,
    });
    assert.equal(answer.status, 404);
    assert.equal(answer.body.error.code, 'BUSINESS_NOT_FOUND');
    // Ada's business, Tobi's location.
    answer = await read(what, ada.cookie, {
      locationId: other.locations[0].id,
    });
    assert.equal(answer.status, 404);
  }
  // Tobi manages VI only: VI reads, Ikoyi is not found.
  await seedManager(database, {
    businessId: business.businessId,
    userId: TOBI.userId,
    locationId: business.locations[0].id,
  });
  assert.equal((await read('insights', tobi.cookie)).status, 200);
  const ikoyi = await read('notes', tobi.cookie, {
    locationId: business.locations[1].id,
  });
  assert.equal(ikoyi.status, 404);
  assert.equal(ikoyi.body.error.code, 'BUSINESS_NOT_FOUND');
});

test('sharing amounts: the person only, with CSRF; the business then sees their weekly total', async () => {
  // Without the browser's CSRF header: refused.
  const noCsrf = await share(
    tobi.cookie,
    tobiMember,
    { share: true },
    {
      origin: WEB,
      'content-type': 'application/json',
      cookie: tobi.cookie,
    },
  );
  assert.equal(noCsrf.status, 403);
  // Someone else's membership: not found.
  const notTheirs = await share(ada.cookie, tobiMember, { share: true });
  assert.equal(notTheirs.status, 404);
  // A bad body.
  assert.equal(
    (await share(tobi.cookie, tobiMember, { share: 'yes' })).status,
    400,
  );
  const on = await share(tobi.cookie, tobiMember, { share: true });
  assert.equal(on.status, 200);
  const membership = (await on.json()).data;
  assert.equal(membership.shareAmounts, true);
  assert.equal(membership.memberId, tobiMember);
  const net = (
    await database.pool.query(
      `SELECT sum(q.recipient_net_minor)::text AS net
         FROM tips t JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
        WHERE t.business_member_id = $1 AND t.status = 'SUCCEEDED'`,
      [tobiMember],
    )
  ).rows[0].net;
  const insights = await read('insights', ada.cookie);
  assert.equal(insights.body.data.people[0].amountMinor, net);
  const off = await share(tobi.cookie, tobiMember, { share: false });
  assert.equal((await off.json()).data.shareAmounts, false);
  assert.equal(
    (await read('insights', ada.cookie)).body.data.people[0].amountMinor,
    undefined,
  );
});
