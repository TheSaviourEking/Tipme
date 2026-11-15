import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  businessNoteRef,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  payAtBusiness,
  seedBusiness,
  seedManager,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// TipMe for businesses, PR B5: the supporter's note through the API (status token, no cookies),
// and the member's and manager's reports (session and CSRF).
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
let memberId;
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
      RATE_LIMIT_BUSINESS_NOTE_PER_HOUR: '1000',
    },
  });
  ada = await signIn(stack.api, ADA.phone);
  tobi = await signIn(stack.api, TOBI.phone);
  business = await seedBusiness(database, {
    owner: TOBI.userId,
    locations: [{ slug: 'vi', name: 'Victoria Island' }, { slug: 'ikoyi' }],
  });
  ({ memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
  }));
});
after(async () => {
  await stack.stop();
  await database.close();
});

/** A paid tip at the business, once the provider's confirmation is booked. */
async function paidTip(withMember = true) {
  const paid = await payAtBusiness(stack.api, {
    handle: 'ada',
    ...(withMember ? { memberId } : {}),
  });
  for (let i = 0; i < 100; i++) {
    const { rows } = await database.pool.query(
      'SELECT status FROM tips WHERE id = $1',
      [paid.tipId],
    );
    if (rows[0]?.status === 'SUCCEEDED') return paid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the tip never became paid');
}

const writeNote = (tipId, token, body, extra = {}) =>
  fetch(`${stack.api}/v1/tips/${tipId}/business-note`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
const status = async (tipId, token) =>
  (
    await (
      await fetch(`${stack.api}/v1/tips/${tipId}/status`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()
  ).data;
const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test('a paid business tip takes one note through the status token: 204, then NOTE_NOT_OPEN', async () => {
  const { tipId, statusToken } = await paidTip();
  assert.deepEqual((await status(tipId, statusToken)).businessNote, {
    business: 'The Yellow Chilli',
    person: 'Tobi',
    written: false,
    open: true,
  });
  const first = await writeNote(tipId, statusToken, {
    tags: ['friendly', 'fast'],
    body: 'Lovely service tonight.',
  });
  assert.equal(first.status, 204);
  assert.equal(first.headers.get('set-cookie'), null);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual((await status(tipId, statusToken)).businessNote, {
    business: 'The Yellow Chilli',
    person: 'Tobi',
    written: true,
    open: false,
  });
  const again = await writeNote(tipId, statusToken, { tags: ['fast'] });
  assert.equal(again.status, 404);
  assert.equal((await again.json()).error.code, 'NOTE_NOT_OPEN');
});

test('a plain tip has no businessNote on the receipt and takes no note', async () => {
  const { tipId, statusToken } = await paidTip(false);
  assert.equal('businessNote' in (await status(tipId, statusToken)), false);
  const response = await writeNote(tipId, statusToken, { tags: ['fast'] });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NOTE_NOT_OPEN');
});

test('text with a link or a phone number is refused with fields ["body"]; nothing is written', async () => {
  const { tipId, statusToken } = await paidTip();
  for (const body of ['See tobi.com', 'Call +234 803 123 4567']) {
    const response = await writeNote(tipId, statusToken, { tags: [], body });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.deepEqual(error.fields, ['body']);
    // The refused words are never echoed back. The support reference is 32 random hex
    // characters and can hold "803" by chance, so it is checked for its own shape and the
    // rest of the error is searched for the refused words.
    const { reference, ...rest } = error;
    assert.match(reference, /^[0-9a-f]{32}$/);
    assert.doesNotMatch(JSON.stringify(rest), /tobi\.com|803/);
  }
  const unknownTag = await writeNote(tipId, statusToken, { tags: ['rude'] });
  assert.equal(unknownTag.status, 400);
  const { rows } = await database.pool.query(
    'SELECT count(*)::int AS n FROM business_notes WHERE tip_id = $1',
    [tipId],
  );
  assert.equal(rows[0].n, 0);
});

test('wrong status token is 404; the route never sets or reads cookies', async () => {
  const { tipId, statusToken } = await paidTip();
  const other = await paidTip();
  for (const token of [undefined, 'wrong-token', other.statusToken]) {
    const response = await writeNote(tipId, token, { tags: ['fast'] });
    assert.equal(response.status, 404, String(token));
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
  // A signed-in cookie is no substitute for the token...
  const withCookie = await writeNote(
    tipId,
    undefined,
    { tags: ['fast'] },
    { cookie: ada.cookie },
  );
  assert.equal(withCookie.status, 404);
  // ...and the token works without one; the answer never sets a cookie.
  const ok = await writeNote(tipId, statusToken, { tags: ['fast'] });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('set-cookie'), null);
  // Cross-origin from the web app without credentials, like the receipt itself.
  const preflight = await fetch(`${stack.api}/v1/tips/${tipId}/business-note`, {
    method: 'OPTIONS',
    headers: {
      origin: WEB,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), WEB);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
});

test('the member lists their notes and reports one; it leaves the business view at once', async () => {
  const { tipId, statusToken } = await paidTip();
  await writeNote(tipId, statusToken, {
    tags: ['great_advice'],
    body: 'Thank you!',
  });
  const unauthenticated = await fetch(`${stack.api}/v1/me/work/notes`);
  assert.equal(unauthenticated.status, 401);
  const list = await call('GET', '/v1/me/work/notes', ada.cookie);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'private, no-store');
  const mine = (await list.json()).data;
  const row = mine.find((note) => note.tipId === tipId);
  assert.equal(row.body, 'Thank you!');
  assert.deepEqual(row.tags, ['great_advice']);
  assert.equal(row.business, 'The Yellow Chilli');
  assert.equal(row.location, 'Victoria Island');
  assert.equal(row.memberId, memberId);
  assert.equal(row.canReport, true);
  // Nothing about the supporter rides along.
  assert.doesNotMatch(JSON.stringify(mine), /payer|private|status_?token/i);
  // Someone else's list never has it; their report is 404.
  const tobiList = (
    await (await call('GET', '/v1/me/work/notes', tobi.cookie)).json()
  ).data;
  assert.equal(
    tobiList.some((note) => note.tipId === tipId),
    false,
  );
  const notMine = await call(
    'POST',
    `/v1/me/work/notes/${tipId}/report`,
    tobi.cookie,
    {
      reason: 'spam',
    },
  );
  assert.equal(notMine.status, 404);
  // Without the CSRF header it is refused.
  const noCsrf = await fetch(`${stack.api}/v1/me/work/notes/${tipId}/report`, {
    method: 'POST',
    headers: { cookie: ada.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'spam' }),
  });
  assert.equal(noCsrf.status, 403);
  const bad = await call(
    'POST',
    `/v1/me/work/notes/${tipId}/report`,
    ada.cookie,
    {
      reason: 'boring',
    },
  );
  assert.equal(bad.status, 400);
  const reported = await call(
    'POST',
    `/v1/me/work/notes/${tipId}/report`,
    ada.cookie,
    {
      reason: 'abusive',
    },
  );
  assert.equal(reported.status, 204);
  const { rows } = await database.pool.query(
    `SELECT reported_by, reason FROM business_note_flags WHERE tip_id = $1`,
    [tipId],
  );
  assert.deepEqual(rows, [{ reported_by: 'member', reason: 'abusive' }]);
  const issues = await database.pool.query(
    `SELECT count(*)::int AS n FROM issues WHERE kind = 'business_note_reported' AND subject->>'tipId' = $1`,
    [tipId],
  );
  assert.equal(issues.rows[0].n, 1);
});

test('the owner reports a note at their business; another business, or a manager of another location, gets 404', async () => {
  const { tipId, statusToken } = await paidTip();
  await writeNote(tipId, statusToken, { tags: ['fast'] });
  // The business knows a note by its reference (B7), never by the tip id, whose UUIDv7 time would
  // give away the visit (merge train 2: the route resolves it with noteTipOf).
  const ref = businessNoteRef(tipId);
  const elsewhere = await seedBusiness(database, { owner: ADA.userId });
  const wrongBusiness = await call(
    'POST',
    `/v1/me/businesses/${elsewhere.businessId}/notes/${ref}/report`,
    ada.cookie,
    { reason: 'spam' },
  );
  assert.equal(wrongBusiness.status, 404);
  assert.equal((await wrongBusiness.json()).error.code, 'BUSINESS_NOT_FOUND');
  await seedManager(database, {
    businessId: business.businessId,
    userId: ADA.userId,
    locationId: business.locations[1].id,
  });
  const otherLocation = await call(
    'POST',
    `/v1/me/businesses/${business.businessId}/notes/${ref}/report`,
    ada.cookie,
    { reason: 'spam' },
  );
  assert.equal(otherLocation.status, 404);
  const byTipId = await call(
    'POST',
    `/v1/me/businesses/${business.businessId}/notes/${tipId}/report`,
    tobi.cookie,
    { reason: 'spam' },
  );
  assert.equal(byTipId.status, 404, 'a raw tip id is not a note reference');
  assert.equal((await byTipId.json()).error.code, 'BUSINESS_NOT_FOUND');
  const owner = await call(
    'POST',
    `/v1/me/businesses/${business.businessId}/notes/${ref}/report`,
    tobi.cookie,
    { reason: 'spam' },
  );
  assert.equal(owner.status, 204);
  const { rows } = await database.pool.query(
    `SELECT reported_by FROM business_note_flags WHERE tip_id = $1`,
    [tipId],
  );
  assert.deepEqual(rows, [{ reported_by: 'manager' }]);
});

test('with a random tip id every route is 404', async () => {
  const id = randomUUID();
  assert.equal((await writeNote(id, 'x', { tags: ['fast'] })).status, 404);
  assert.equal(
    (
      await call('POST', `/v1/me/work/notes/${id}/report`, ada.cookie, {
        reason: 'spam',
      })
    ).status,
    404,
  );
});
