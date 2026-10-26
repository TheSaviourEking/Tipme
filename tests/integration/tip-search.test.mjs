import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { WEB, signIn, startStack } from './helpers.mjs';

// Tip search (PR-013, PRD v1.1 FR-05 "searchable transaction history"): by supporter name, by
// amount, or by the end of the payment reference, only ever within the recipient's own tips.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let tobi;
const references = {};
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
  await tip('tobi', '200000', 'Ada M.');
  await tip('tobi', '500000', 'Bola');
  await tip('tobi', '250000', 'Chidi O.');
  await tip('ada', '500000', 'Bola');
  tobi = (await signIn(stack.api, '+2348000000002')).cookie;
  // Wait until the provider's confirmations are booked.
  for (let i = 0; i < 50; i++) {
    const { rows } = await database.pool.query(
      `SELECT count(*)::int AS n FROM tips WHERE status = 'SUCCEEDED'`,
    );
    if (rows[0].n === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { rows } = await database.pool.query(
    `SELECT t.payer_display_label AS label, a.provider_reference AS ref
       FROM tips t JOIN payment_attempts a ON a.intent_id = t.intent_id
       JOIN profiles p ON p.id = t.profile_id WHERE p.handle_lower = 'tobi'`,
  );
  for (const row of rows) references[row.label] = row.ref;
});
after(async () => {
  await stack.stop();
  await database.close();
});

async function tip(handle, amountMinor, payerDisplayLabel) {
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, amountMinor, currency: 'NGN' }),
    })
  ).json();
  const intent = await (
    await fetch(`${stack.api}/v1/tip-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        quoteId: quote.data.quoteId,
        payerDisplayLabel,
      }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeed' }),
  });
}

const search = async (q, extra = '') =>
  (
    await (
      await fetch(
        `${stack.api}/v1/me/tips?q=${encodeURIComponent(q)}${extra}`,
        { headers: { cookie: tobi } },
      )
    ).json()
  ).data.items.map((item) => item.supporterLabel);

test('search finds tips by supporter name, in any case, only among the recipient’s own', async () => {
  assert.deepEqual(await search('bola'), ['Bola'], 'not Ada’s tip from Bola');
  assert.deepEqual(await search('ADA'), ['Ada M.']);
  assert.deepEqual(await search('zz-nobody'), []);
  assert.equal(
    (await search('')).length,
    3,
    'an empty search lists everything',
  );
});

test('search finds tips by amount, written with or without commas, and by the end of the reference', async () => {
  assert.deepEqual(await search('5000'), ['Bola']);
  assert.deepEqual(await search('5,000'), ['Bola']);
  assert.deepEqual(await search('2,500'), ['Chidi O.']);
  const tail = references['Chidi O.'].slice(-6);
  assert.deepEqual(await search(tail), ['Chidi O.']);
  assert.deepEqual(await search(tail.slice(-4)), ['Chidi O.']);
  // Only the 6 characters the tip page already shows can match: a longer ending cannot be
  // used to rebuild the provider's whole reference one guess at a time.
  assert.deepEqual(await search(references['Chidi O.'].slice(-8)), []);
  // Combined with the status filter.
  assert.deepEqual(await search('bola', '&status=confirming'), []);
});

test('search text is bounded and treated as text, never as a pattern', async () => {
  assert.deepEqual(await search('%'), []);
  assert.deepEqual(await search('_'), []);
  const long = await fetch(`${stack.api}/v1/me/tips?q=${'a'.repeat(200)}`, {
    headers: { cookie: tobi },
  });
  assert.equal(long.status, 400);
});
