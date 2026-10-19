import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
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
});
after(async () => {
  await stack.stop();
  await database.close();
});

const json = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
async function tip(handle, extra = {}) {
  const quote = await (
    await fetch(
      `${stack.api}/v1/tip-quotes`,
      json({ handle, amountMinor: '200000', currency: 'NGN' }),
    )
  ).json();
  const intent = await (
    await fetch(
      `${stack.api}/v1/tip-intents`,
      json(
        { quoteId: quote.data.quoteId, ...extra },
        { 'idempotency-key': randomUUID() },
      ),
    )
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(
    `${stack.api}/v1/mock-provider/checkout/${reference}`,
    json({ outcome: 'succeed' }),
  );
  return { tipId: intent.data.tipId, quote: quote.data };
}

test('a first tip becomes a private moment the recipient can share, and supporters can add to it', async () => {
  const { cookie } = await signIn(stack.api, '+2348031260001');
  await fetch(`${stack.api}/v1/me/page`, {
    method: 'POST',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ handle: 'celebrant' }),
  });
  await fetch(`${stack.api}/v1/me/page/state`, {
    method: 'PUT',
    headers: browserHeaders(cookie),
    body: JSON.stringify({ state: 'live' }),
  });
  await tip('celebrant');
  const deadline = Date.now() + 10_000;
  let moments = [];
  while (Date.now() < deadline && moments.length === 0) {
    moments = (
      await (
        await fetch(`${stack.api}/v1/me/moments`, { headers: { cookie } })
      ).json()
    ).data;
    if (moments.length === 0) await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(moments[0].title, 'Your first tip! Someone noticed your work.');
  assert.equal(
    (await (await fetch(`${stack.api}/v1/profiles/celebrant`)).json()).data
      .celebration,
    undefined,
  );
  const share = await fetch(
    `${stack.api}/v1/me/moments/${moments[0].id}/share`,
    { method: 'POST', headers: browserHeaders(cookie), body: '{}' },
  );
  assert.equal(share.status, 204);
  const page = (
    await (await fetch(`${stack.api}/v1/profiles/celebrant`)).json()
  ).data;
  assert.deepEqual(page.celebration, {
    momentId: moments[0].id,
    label: 'first tip',
  });
  const { tipId } = await tip('celebrant', {
    celebrationMomentId: moments[0].id,
  });
  const [row] = (
    await database.pool.query(
      'SELECT celebration_moment_id FROM tips WHERE id = $1',
      [tipId],
    )
  ).rows;
  assert.equal(row.celebration_moment_id, moments[0].id);
  // Another person's moment id cannot label a tip.
  const { tipId: other } = await tip('tobi', {
    celebrationMomentId: moments[0].id,
  });
  assert.equal(
    (
      await database.pool.query(
        'SELECT celebration_moment_id FROM tips WHERE id = $1',
        [other],
      )
    ).rows[0].celebration_moment_id,
    null,
  );
});

test('quotes say when a tip is fee-free', async () => {
  const { quote } = await tip('ada');
  assert.equal(quote.feeFree, false);
});
