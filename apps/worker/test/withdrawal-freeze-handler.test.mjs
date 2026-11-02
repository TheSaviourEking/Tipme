import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleWithdrawalFreezeOpened } from '../dist/handlers/withdrawal-freeze.js';

const URL_WITH_SECRET =
  'https://hooks.example.test/services/T0/B0/very-secret-token';
const ISSUE = '01890000-0000-7000-8000-000000000001';

test('a new takeover issue posts its id, and never a reason or a provider', async () => {
  const sent = [];
  const outcome = await handleWithdrawalFreezeOpened(
    { issueId: ISSUE, profileId: ISSUE, reason: 'Written words' },
    {
      url: URL_WITH_SECRET,
      fetchImpl: async (url, init) => {
        sent.push({ url, text: JSON.parse(init.body).text });
        return new Response('ok', { status: 200 });
      },
    },
  );
  assert.equal(outcome, 'sent');
  assert.equal(sent[0].url, URL_WITH_SECRET);
  assert.ok(sent[0].text.includes(ISSUE));
  assert.match(sent[0].text, /frozen/);
  assert.doesNotMatch(
    sent[0].text,
    /Written words|bachs|stripe|paystack|mock/i,
  );
});

test('anything but a real issue id is left out of the text', async () => {
  for (const data of [{ issueId: '<@here>' }, {}, null, undefined]) {
    const sent = [];
    await handleWithdrawalFreezeOpened(data, {
      url: URL_WITH_SECRET,
      fetchImpl: async (_url, init) => {
        sent.push(JSON.parse(init.body).text);
        return new Response('ok', { status: 200 });
      },
    });
    assert.match(sent[0], /a new issue/);
    assert.doesNotMatch(sent[0], /@here/);
  }
});

test('a failed post throws, so the job retries, without the route in the error', async () => {
  await assert.rejects(
    handleWithdrawalFreezeOpened(
      { issueId: ISSUE },
      {
        url: URL_WITH_SECRET,
        fetchImpl: async () => new Response('no', { status: 500 }),
      },
    ),
    (error) => !String(error.message).includes('very-secret-token'),
  );
});

test('with no route it is logged, not lost silently', async () => {
  const logged = [];
  assert.equal(
    await handleWithdrawalFreezeOpened(
      { issueId: ISSUE },
      { url: undefined, log: (entry) => logged.push(entry) },
    ),
    'unrouted',
  );
  assert.equal(logged[0].event, 'withdrawals.freeze_alert_unrouted');
});
