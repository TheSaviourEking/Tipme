import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handlePlatformRefusal } from '../dist/handlers/platform-refusal.js';
import { handleWithdrawalsSwitchChanged } from '../dist/handlers/withdrawals-switch.js';

const URL_WITH_SECRET =
  'https://hooks.example.test/services/T0/B0/very-secret-token';

const recording = () => {
  const sent = [];
  return {
    sent,
    fetchImpl: async (url, init) => {
      sent.push({ url, text: JSON.parse(init.body).text });
      return new Response('ok', { status: 200 });
    },
  };
};

test('off and on each post their own text to the alert route', async () => {
  const route = recording();
  const deps = { url: URL_WITH_SECRET, fetchImpl: route.fetchImpl };
  assert.equal(
    await handleWithdrawalsSwitchChanged({ state: 'off' }, deps),
    'sent',
  );
  assert.equal(
    await handleWithdrawalsSwitchChanged({ state: 'on' }, deps),
    'sent',
  );
  assert.equal(route.sent[0].url, URL_WITH_SECRET);
  assert.match(route.sent[0].text, /switched OFF/);
  assert.match(route.sent[1].text, /switched back ON/);
});

test('switching on says held withdrawals stay with staff, not that everything starts', async () => {
  const route = recording();
  await handleWithdrawalsSwitchChanged(
    { state: 'on' },
    { url: URL_WITH_SECRET, fetchImpl: route.fetchImpl },
  );
  assert.match(route.sent[0].text, /hold/i);
});

test('anything but a clear "on" reads as off, so someone looks', async () => {
  for (const data of [{ state: 'ON' }, {}, null, undefined, 'on']) {
    const route = recording();
    await handleWithdrawalsSwitchChanged(data, {
      url: URL_WITH_SECRET,
      fetchImpl: route.fetchImpl,
    });
    assert.match(route.sent[0].text, /switched OFF/, JSON.stringify(data));
  }
});

test('the text carries no reason, even if the payload did', async () => {
  const route = recording();
  await handleWithdrawalsSwitchChanged(
    { state: 'off', reason: 'A private written reason' },
    { url: URL_WITH_SECRET, fetchImpl: route.fetchImpl },
  );
  assert.doesNotMatch(route.sent[0].text, /private written reason/);
});

test('a failed post throws, so the job retries, without the route address', async () => {
  await assert.rejects(
    handleWithdrawalsSwitchChanged(
      { state: 'off' },
      {
        url: URL_WITH_SECRET,
        fetchImpl: async () => new Response('nope', { status: 500 }),
      },
    ),
    (error) => !String(error.message).includes('very-secret-token'),
  );
});

test('with no route it is logged and reported unrouted, not sent', async () => {
  const entries = [];
  assert.equal(
    await handleWithdrawalsSwitchChanged(
      { state: 'off' },
      { url: undefined, log: (entry) => entries.push(entry) },
    ),
    'unrouted',
  );
  assert.equal(entries[0].event, 'withdrawals.switch_alert_unrouted');
});

test('a platform refusal tells staff in plain words, and a failed post retries', async () => {
  const route = recording();
  const deps = { url: URL_WITH_SECRET, fetchImpl: route.fetchImpl };
  assert.equal(
    await handlePlatformRefusal({ cause: 'reserve_empty' }, deps),
    'sent',
  );
  assert.equal(
    await handlePlatformRefusal({ cause: 'provider_key' }, deps),
    'sent',
  );
  assert.match(route.sent[0].text, /reserve/i);
  assert.match(route.sent[1].text, /key/i);
  await assert.rejects(
    handlePlatformRefusal(
      { cause: 'reserve_empty' },
      {
        url: URL_WITH_SECRET,
        fetchImpl: async () => new Response('no', { status: 500 }),
      },
    ),
    /alert_route_refused_500/,
  );
  assert.equal(
    await handlePlatformRefusal({ cause: 'reserve_empty' }, { url: undefined }),
    'unrouted',
  );
});
