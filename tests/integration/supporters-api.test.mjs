import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  DEMO_PROFILES,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { WEB, startStack, setSwitch } from './helpers.mjs';

// Repeat supporters, the supporter's choice (pretend payments only): the opt-in key on the tip
// request, the receipt's "recognised", the stop, and the SUPPORTER_RECOGNITION switch.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const ADA = DEMO_PROFILES[0];
const env = {
  WEB_ORIGIN: WEB,
  RATE_LIMIT_QUOTES_PER_MIN: '1000',
  RATE_LIMIT_INTENTS_PER_MIN: '1000',
};
let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  await database.pool.query("UPDATE profiles SET plan = 'pro' WHERE id = $1", [
    ADA.id,
  ]);
  stack = await startStack({ databaseUrl: database.url, apiEnv: env });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const newKey = () => randomBytes(32).toString('base64url');
const post = (api, path, body, headers = {}) =>
  fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** A paid pretend tip to Ada; returns the tab's tip id and status token. */
async function paidTip(api, extra) {
  const quote = await (
    await post(api, '/v1/tip-quotes', {
      handle: 'ada',
      amountMinor: '200000',
      currency: 'NGN',
    })
  ).json();
  const response = await post(
    api,
    '/v1/tip-intents',
    { quoteId: quote.data.quoteId, ...extra },
    { 'idempotency-key': randomUUID() },
  );
  assert.equal(
    response.status,
    201,
    JSON.stringify(await response.clone().json()),
  );
  const intent = (await response.json()).data;
  const reference = intent.checkoutUrl.split('/mock-checkout/')[1];
  await post(api, `/v1/mock-provider/checkout/${reference}`, {
    outcome: 'succeed',
  });
  return intent;
}
const receipt = async (api, { tipId, statusToken }) => {
  for (let i = 0; i < 50; i += 1) {
    const response = await fetch(`${api}/v1/tips/${tipId}/status`, {
      headers: { authorization: `Bearer ${statusToken}` },
    });
    const { data } = await response.json();
    if (data?.state === 'paid') return data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('the tip never showed as paid');
};
const stop = (api, tipId, token) =>
  fetch(`${api}/v1/tips/${tipId}/recognition/stop`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const count = async (table) =>
  (await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]
    .n;

test('a Pro page offers recognition on its public page', async () => {
  const response = await fetch(`${stack.api}/v1/profiles/ada`);
  assert.equal((await response.json()).data.recognition, true);
});

test('a tip with the key on a Pro page: the receipt says recognised', async () => {
  const tip = await paidTip(stack.api, {
    payerDisplayLabel: 'Chidi',
    supporterKey: newKey(),
  });
  assert.equal((await receipt(stack.api, tip)).recognised, true);
  const plain = await paidTip(stack.api, { payerDisplayLabel: 'Chidi' });
  assert.equal('recognised' in (await receipt(stack.api, plain)), false);
});

test('a malformed key is refused before anything is made', async () => {
  const quote = await (
    await post(stack.api, '/v1/tip-quotes', {
      handle: 'ada',
      amountMinor: '200000',
      currency: 'NGN',
    })
  ).json();
  const response = await post(
    stack.api,
    '/v1/tip-intents',
    { quoteId: quote.data.quoteId, supporterKey: 'too-short' },
    { 'idempotency-key': randomUUID() },
  );
  assert.equal(response.status, 400);
  assert.doesNotMatch(JSON.stringify(await response.json()), /too-short/);
});

test('stop with the token: 204; the supporter row is gone; the tips and notes remain', async () => {
  const key = newKey();
  const first = await paidTip(stack.api, {
    payerDisplayLabel: 'Bisi',
    supporterKey: key,
    message: 'You made my week',
  });
  const second = await paidTip(stack.api, {
    payerDisplayLabel: 'Bisi',
    supporterKey: key,
  });
  const hash = createHash('sha256').update(key).digest();
  const supporter = async () =>
    (
      await database.pool.query(
        'SELECT id FROM supporters WHERE key_hash = $1',
        [hash],
      )
    ).rows[0];
  const before = await supporter();
  assert.ok(before);
  const tipsBefore = await count('tips');
  const response = await stop(stack.api, second.tipId, second.statusToken);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await supporter(), undefined);
  assert.equal(
    (
      await database.pool.query(
        'SELECT count(*)::int AS n FROM tip_supporters WHERE supporter_id = $1',
        [before.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(await count('tips'), tipsBefore);
  assert.equal(
    (
      await database.pool.query(
        'SELECT body FROM tip_messages WHERE tip_id = $1',
        [first.tipId],
      )
    ).rows[0].body,
    'You made my week',
  );
  // Both receipts stop offering it: their tips are no longer grouped.
  assert.equal('recognised' in (await receipt(stack.api, first)), false);
  assert.equal('recognised' in (await receipt(stack.api, second)), false);
});

test('stop twice: 204; a wrong token, no token or an unknown tip: 404', async () => {
  const tip = await paidTip(stack.api, {
    payerDisplayLabel: 'Ngozi',
    supporterKey: newKey(),
  });
  assert.equal((await stop(stack.api, tip.tipId, tip.statusToken)).status, 204);
  assert.equal((await stop(stack.api, tip.tipId, tip.statusToken)).status, 204);
  const other = await paidTip(stack.api, {
    payerDisplayLabel: 'Ngozi',
    supporterKey: newKey(),
  });
  // Another tip's token, a made-up one, none, and a tip that does not exist look the same.
  for (const [tipId, token] of [
    [other.tipId, tip.statusToken],
    [other.tipId, 'not-a-real-token'],
    [other.tipId, undefined],
    [randomUUID(), tip.statusToken],
    ['not-a-uuid', tip.statusToken],
  ])
    assert.equal((await stop(stack.api, tipId, token)).status, 404);
  assert.equal((await receipt(stack.api, other)).recognised, true);
});

test('no log line from the tip request contains the key or its hash', async () => {
  const key = newKey();
  const hex = createHash('sha256').update(key).digest('hex');
  const tip = await paidTip(stack.api, {
    payerDisplayLabel: 'Femi',
    supporterKey: key,
  });
  await stop(stack.api, tip.tipId, tip.statusToken);
  const output = JSON.stringify(stack.logs);
  assert.ok(output.length > 0);
  assert.ok(!output.includes(key), 'a log line holds the key');
  assert.ok(!output.includes(hex), 'a log line holds the hash');
});

test('the supporter_recognition switch off: the public page has no recognition flag and the key is ignored', async () => {
  const off = await startStack({
    databaseUrl: database.url,
    apiEnv: env,
  });
  // The switch is stored, set in admin: this copy differs only in name.
  await setSwitch(database.pool, 'supporter_recognition', false);
  try {
    const page = await (await fetch(`${off.api}/v1/profiles/ada`)).json();
    assert.equal(page.data.plan, 'pro');
    assert.equal('recognition' in page.data, false);
    const supportersBefore = await count('supporters');
    const linksBefore = await count('tip_supporters');
    const tip = await paidTip(off.api, {
      payerDisplayLabel: 'Kola',
      supporterKey: newKey(),
    });
    assert.equal('recognised' in (await receipt(off.api, tip)), false);
    assert.equal(await count('supporters'), supportersBefore);
    assert.equal(await count('tip_supporters'), linksBefore);
    // Nothing is deleted while it is off: earlier supporters are all still there.
    assert.ok(supportersBefore > 0);
  } finally {
    await setSwitch(database.pool, 'supporter_recognition', true);
    await off.stop();
  }
});
