import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  listIssues,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
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

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function paidTipToTobi(message) {
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
        ...(message ? { message } : {}),
      }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeed' }),
  });
  // Wait until the provider's confirmation has been booked.
  for (let i = 0; i < 50; i++) {
    const { rows } = await database.pool.query(
      'SELECT status FROM tips WHERE id = $1',
      [intent.data.tipId],
    );
    if (rows[0]?.status === 'SUCCEEDED') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return intent.data.tipId;
}

test('a recipient reports a message: it is hidden from them and becomes an admin issue without its text', async () => {
  const tobi = await signIn(stack.api, '+2348000000002');
  const tipId = await paidTipToTobi('You are rude and I hate this xyzzy');
  const detail = async () =>
    (await (await call('GET', `/v1/me/tips/${tipId}`, tobi.cookie)).json())
      .data;
  assert.equal((await detail()).message, 'You are rude and I hate this xyzzy');

  assert.equal(
    (
      await call('POST', `/v1/me/tips/${tipId}/message/report`, tobi.cookie, {
        reason: 'insult',
      })
    ).status,
    400,
  );
  const reported = await call(
    'POST',
    `/v1/me/tips/${tipId}/message/report`,
    tobi.cookie,
    {
      reason: 'abusive',
    },
  );
  assert.equal(reported.status, 200);
  const after = await detail();
  assert.equal(after.message, null);
  assert.equal(after.messageHidden, true);
  assert.equal(after.messageReported, true);

  // Reporting twice changes nothing; one issue, with no message text in it.
  await call('POST', `/v1/me/tips/${tipId}/message/report`, tobi.cookie, {
    reason: 'abusive',
  });
  const issues = (
    await listIssues(database.db, { kind: 'message_reported', limit: 20 })
  ).filter((issue) => issue.subject.tipId === tipId);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'account');
  assert.match(issues[0].summary, /@tobi/);
  assert.equal(JSON.stringify(issues).includes('xyzzy'), false);

  const list = (await (await call('GET', '/v1/me/tips', tobi.cookie)).json())
    .data.items;
  assert.equal(
    list.find((t) => t.tipId === tipId).hasMessage,
    false,
    'hidden from the list too',
  );
});

test('hiding without reporting opens no issue', async () => {
  const tobi = await signIn(stack.api, '+2348000000002');
  const tipId = await paidTipToTobi('Not my favourite note');
  assert.equal(
    (await call('POST', `/v1/me/tips/${tipId}/message/hide`, tobi.cookie, {}))
      .status,
    200,
  );
  const detail = (
    await (await call('GET', `/v1/me/tips/${tipId}`, tobi.cookie)).json()
  ).data;
  assert.deepEqual(
    [detail.message, detail.messageHidden, detail.messageReported],
    [null, true, false],
  );
  const issues = await listIssues(database.db, {
    kind: 'message_reported',
    limit: 50,
  });
  assert.equal(
    issues.some((issue) => issue.subject.tipId === tipId),
    false,
  );
});

test('nobody can report or hide a message on someone else’s tip, or a tip without one (Review Focus 3)', async () => {
  const tipId = await paidTipToTobi('A kind note');
  const ada = await signIn(stack.api, '+2348000000001');
  for (const action of ['report', 'hide'])
    assert.equal(
      (
        await call(
          'POST',
          `/v1/me/tips/${tipId}/message/${action}`,
          ada.cookie,
          { reason: 'spam' },
        )
      ).status,
      404,
      action,
    );
  const tobi = await signIn(stack.api, '+2348000000002');
  const silent = await paidTipToTobi(undefined);
  assert.equal(
    (
      await call('POST', `/v1/me/tips/${silent}/message/report`, tobi.cookie, {
        reason: 'spam',
      })
    ).status,
    404,
  );
});
