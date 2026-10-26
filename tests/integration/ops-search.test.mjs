import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import { WEB, opsSignIn, signIn, startStack } from './helpers.mjs';

// Admin search (PR-013, PRD v1.1 FR-09 "role-controlled search across accounts, payment intents,
// ledger entries, payout attempts"): ids and short labels only, permission search.view, audited
// without the query itself.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
let staff;
let tipId;
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
  staff = await opsSignIn(stack.api, database.db, '+2348031300099');
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: 'tobi',
        amountMinor: '200000',
        currency: 'NGN',
      }),
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
        message: 'A private note',
        payerDisplayLabel: 'Zed Q.',
      }),
    })
  ).json();
  tipId = intent.data.tipId;
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeed' }),
  });
  for (let i = 0; i < 50; i++) {
    const { rows } = await database.pool.query(
      `SELECT status FROM tips WHERE id = $1`,
      [tipId],
    );
    if (rows[0]?.status === 'SUCCEEDED') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});
after(async () => {
  await stack.stop();
  await database.close();
});

const search = (q, cookie = staff.cookie) =>
  fetch(`${stack.api}/v1/ops/search?q=${encodeURIComponent(q)}`, {
    headers: { cookie },
  });

test('staff find a page by handle or name, a tip by id or reference, and its ledger entry', async () => {
  const byHandle = (await (await search('tob')).json()).data;
  assert.deepEqual(
    byHandle.pages.map((p) => p.handle),
    ['tobi'],
  );
  const byName = (await (await search('Tobi')).json()).data;
  assert.ok(byName.pages.some((p) => p.handle === 'tobi'));

  const byTip = (await (await search(tipId)).json()).data;
  assert.equal(byTip.tips.length, 1);
  assert.equal(byTip.tips[0].tipId, tipId);
  assert.equal(byTip.tips[0].handle, 'tobi');
  assert.equal(byTip.tips[0].status, 'SUCCEEDED');

  const { rows } = await database.pool.query(
    `SELECT a.provider_reference AS ref, lt.id AS txn FROM tips t
       JOIN payment_attempts a ON a.intent_id = t.intent_id
       JOIN ledger_transactions lt ON lt.tip_id = t.id WHERE t.id = $1`,
    [tipId],
  );
  // The whole reference (copied from the provider's dashboard), or the 6-character ending
  // staff see in the evidence; never a longer partial ending.
  for (const q of [rows[0].ref, rows[0].ref.slice(-6)]) {
    const byRef = (await (await search(q)).json()).data;
    assert.deepEqual(
      byRef.tips.map((t) => t.tipId),
      [tipId],
      q,
    );
  }
  assert.deepEqual(
    (await (await search(rows[0].ref.slice(-8))).json()).data.tips,
    [],
  );
  const byTxn = (await (await search(rows[0].txn)).json()).data;
  assert.deepEqual(
    byTxn.ledgerTransactions.map((t) => [t.transactionId, t.tipId]),
    [[rows[0].txn, tipId]],
  );
});

test('results never carry phone numbers, emails, supporter names or messages', async () => {
  const body = JSON.stringify((await (await search(tipId)).json()).data);
  for (const leak of ['+234', 'Zed Q.', 'A private note', '@example'])
    assert.equal(body.includes(leak), false, leak);
});

test('search needs the search.view permission, a sensible query, and is audited without the query', async () => {
  assert.equal((await search('t')).status, 400, 'too short');
  assert.equal((await search('x'.repeat(101))).status, 400, 'too long');
  const recipient = await signIn(stack.api, '+2348000000002');
  assert.equal((await search('tobi', recipient.cookie)).status, 404);
  const { rows } = await database.pool.query(
    `SELECT action, permission, subject_id, reason FROM audit_events WHERE action = 'search.performed' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(rows[0].permission, 'search.view');
  assert.equal(
    JSON.stringify(rows[0]).includes('tobi'),
    false,
    'not the query',
  );
  assert.match(rows[0].subject_id, /^\d+ characters$/);
});
