import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  createSession,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import {
  payAtBusiness,
  seedBusiness,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import {
  WEB,
  browserHeaders,
  openEventStream,
  startStack,
} from './helpers.mjs';

// TipMe for businesses, plan B9 Task 23: `business.changed` reaches the managers of the business a
// change belongs to (and the person it is about), never another business's. Signals carry no data.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const [ADA, TOBI] = DEMO_PROFILES;
let database;
let stack;
let business;
let memberId;
// Tobi owns the business Ada works at; Femi owns another one.
let tobi;
let ada;
let femi;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      BUSINESS_ENABLED: 'true',
      LIVE_UPDATES_ENABLED: 'true',
      LIVE_HEARTBEAT_MS: '1000',
      RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
      RATE_LIMIT_BUSINESS_NOTE_PER_HOUR: '1000',
    },
  });
  business = await seedBusiness(database, {
    owner: TOBI.userId,
    locations: [{ slug: 'vi', name: 'Victoria Island' }],
  });
  ({ memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA.id,
    shownName: 'Ada',
  }));
  const femiId = randomUUID();
  await database.pool.query(
    'INSERT INTO users (id, email, email_verified_at) VALUES ($1, $2, now())',
    [femiId, `femi.${femiId.slice(0, 8)}@example.com`],
  );
  await seedBusiness(database, { owner: femiId, name: 'Femi’s Grill' });
  tobi = await sessionFor(TOBI.userId);
  ada = await sessionFor(ADA.userId);
  femi = await sessionFor(femiId);
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

async function sessionFor(userId) {
  const { token } = await createSession(database.db, {
    userId,
    deviceLabel: 'Integration test',
  });
  return `tipme_session=${token}`;
}

const READY = /^data: \{"type":"ready"\}$/;
const frame = (type) => new RegExp(`^data: \\{"type":"${type}"\\}$`);
const count = (stream, type) =>
  stream.frames.filter((f) => frame(type).test(f)).length;

async function streamOf(t, cookie) {
  const stream = await openEventStream(`${stack.api}/v1/me/events`, {
    cookie,
    origin: WEB,
  });
  t.after(() => stream.close());
  assert.equal(stream.status, 200);
  await stream.waitFor(READY);
  return stream;
}

/** Waits until `stream` has more than `before` frames of `type`. */
async function more(stream, type, before, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (count(stream, type) > before) return;
    await sleep(50);
  }
  assert.fail(`no new ${type}: ${JSON.stringify(stream.frames)}`);
}

async function paidTip() {
  const paid = await payAtBusiness(stack.api, { handle: 'ada', memberId });
  for (let i = 0; i < 100; i++) {
    const { rows } = await database.pool.query(
      'SELECT status FROM tips WHERE id = $1',
      [paid.tipId],
    );
    if (rows[0]?.status === 'SUCCEEDED') return paid;
    await sleep(100);
  }
  throw new Error('the tip never became paid');
}

test('a paid tip at a business signals its managers and the person, and no other business', async (t) => {
  const tobiStream = await streamOf(t, tobi);
  const adaStream = await streamOf(t, ada);
  const femiStream = await streamOf(t, femi);
  const managerBefore = count(tobiStream, 'business.changed');
  const tipsBefore = count(adaStream, 'tips.changed');
  const workBefore = count(adaStream, 'business.changed');
  await paidTip();
  await more(tobiStream, 'business.changed', managerBefore);
  await more(adaStream, 'tips.changed', tipsBefore);
  await more(adaStream, 'business.changed', workBefore);
  await sleep(1500);
  assert.equal(count(femiStream, 'business.changed'), 0);
  // Only the type reaches the browser.
  for (const f of tobiStream.frames.filter((f) => f.startsWith('data: ')))
    assert.deepEqual(Object.keys(JSON.parse(f.slice(6))), ['type']);
});

test('a note written after paying signals the managers', async (t) => {
  const { tipId, statusToken } = await paidTip();
  const tobiStream = await streamOf(t, tobi);
  const femiStream = await streamOf(t, femi);
  const before = count(tobiStream, 'business.changed');
  const written = await fetch(`${stack.api}/v1/tips/${tipId}/business-note`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${statusToken}`,
    },
    body: JSON.stringify({ tags: ['friendly'] }),
  });
  assert.equal(written.status, 204);
  await more(tobiStream, 'business.changed', before);
  await sleep(1500);
  assert.equal(count(femiStream, 'business.changed'), 0);
});

test('checking in signals the managers; a location edit signals the team', async (t) => {
  const tobiStream = await streamOf(t, tobi);
  const adaStream = await streamOf(t, ada);
  const femiStream = await streamOf(t, femi);
  let before = count(tobiStream, 'business.changed');
  const started = await fetch(
    `${stack.api}/v1/me/work/${memberId}/shift/start`,
    { method: 'POST', headers: browserHeaders(ada) },
  );
  assert.equal(started.status, 200);
  await more(tobiStream, 'business.changed', before);

  before = count(adaStream, 'business.changed');
  const edited = await fetch(
    `${stack.api}/v1/me/businesses/${business.businessId}/locations/${business.locations[0].id}`,
    {
      method: 'PATCH',
      headers: browserHeaders(tobi),
      body: JSON.stringify({ name: 'Victoria Island Live' }),
    },
  );
  assert.equal(edited.status, 200);
  await more(adaStream, 'business.changed', before);
  await sleep(1500);
  assert.equal(count(femiStream, 'business.changed'), 0);
});
