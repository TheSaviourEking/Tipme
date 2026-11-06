import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PAYOUT_START_EVENT,
  PLATFORM_REFUSAL_EVENT,
  WITHDRAWAL_FREEZE_OPENED_EVENT,
  WITHDRAWALS_SWITCH_EVENT,
  parseLiveMessage,
} from '@tipme/contracts';
import { DOMAIN_EVENT_NAMES } from '../dist/handlers/domain-events.js';
import { createWorkerLivePublisher } from '../dist/live-publisher.js';
import {
  LIVE_SIGNAL_MAPPED_EVENTS,
  jobSignalsFor,
  liveSignalFor,
} from '../dist/live-signals.js';

const PROFILE = '22222222-2222-4222-8222-222222222222';
const TIP = '55555555-5555-4555-8555-555555555555';

test('tip.succeeded and tip.failed map to tips.changed for their profile', () => {
  for (const type of ['tip.succeeded', 'tip.failed'])
    assert.deepEqual(liveSignalFor(type, { tipId: TIP, profileId: PROFILE }), [
      { to: { profile: PROFILE }, type: 'tips.changed' },
    ]);
});

test('every outbox event type the database writes has an explicit mapping, even if []', () => {
  // Everything the relay can put on the queue: the domain events and the named job events.
  const relayed = [
    ...DOMAIN_EVENT_NAMES,
    PAYOUT_START_EVENT,
    PLATFORM_REFUSAL_EVENT,
    WITHDRAWAL_FREEZE_OPENED_EVENT,
    WITHDRAWALS_SWITCH_EVENT,
  ];
  for (const name of relayed)
    assert.ok(
      LIVE_SIGNAL_MAPPED_EVENTS.has(name),
      `${name} has no live mapping`,
    );
  // And nothing stale: every mapped name is still relayed.
  for (const name of LIVE_SIGNAL_MAPPED_EVENTS)
    assert.ok(relayed.includes(name), `${name} is mapped but never relayed`);
});

test('an unknown event maps to []', () => {
  assert.deepEqual(liveSignalFor('something.new', { profileId: PROFILE }), []);
});

test('a payload without a uuid profileId maps to []', () => {
  for (const payload of [
    null,
    undefined,
    {},
    { profileId: 'nope' },
    { profileId: 7 },
    'x',
  ])
    assert.deepEqual(liveSignalFor('tip.succeeded', payload), []);
});

test('every signal is a valid channel message', () => {
  const messages = [
    ...liveSignalFor('tip.succeeded', { profileId: PROFILE }),
    ...jobSignalsFor('tip.succeeded', 'notified', {
      tipId: TIP,
      profileId: PROFILE,
    }),
  ];
  for (const m of messages)
    assert.deepEqual(parseLiveMessage(JSON.stringify(m)), m);
});

test('jobSignalsFor tip.succeeded notified gives notifications.changed and moments.changed; skipped gives []', () => {
  const data = { tipId: TIP, profileId: PROFILE, _trace: {} };
  const expected = [
    { to: { profile: PROFILE }, type: 'notifications.changed' },
    { to: { profile: PROFILE }, type: 'moments.changed' },
  ];
  assert.deepEqual(jobSignalsFor('tip.succeeded', 'notified', data), expected);
  assert.deepEqual(jobSignalsFor('tip.succeeded', 'duplicate', data), expected);
  assert.deepEqual(jobSignalsFor('tip.succeeded', 'skipped', data), []);
  assert.deepEqual(jobSignalsFor('tip.failed', 'logged', data), []);
  assert.deepEqual(
    jobSignalsFor('tip.succeeded', 'notified', { profileId: 'x' }),
    [],
  );
});

function fakeLogger() {
  const lines = [];
  return {
    lines,
    logger: { warn: (l) => lines.push(l), info: () => undefined },
  };
}

test('a publish that rejects is swallowed and counted outcome=failed', async () => {
  const counted = [];
  const { lines, logger } = fakeLogger();
  const publish = createWorkerLivePublisher({
    redis: {
      publish: async () => {
        throw new Error('Connection is closed.');
      },
    },
    channel: 'w:live:v1',
    logger,
    counter: { add: (n, attributes) => counted.push([n, attributes]) },
  });
  await publish([
    { to: { profile: PROFILE }, type: 'tips.changed' },
    { to: { profile: PROFILE }, type: 'moments.changed' },
  ]);
  assert.deepEqual(counted, [
    [1, { type: 'tips.changed', outcome: 'failed' }],
    [1, { type: 'moments.changed', outcome: 'failed' }],
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'live.publish_failed');
  assert.equal(lines[0].error, 'Error');
  assert.ok(!JSON.stringify(lines).includes(PROFILE));
});

test('a publish sends each message as {to,type} JSON on the channel', async () => {
  const sent = [];
  const counted = [];
  const publish = createWorkerLivePublisher({
    redis: {
      publish: async (channel, body) => (sent.push([channel, body]), 1),
    },
    channel: 'w:live:v1',
    logger: fakeLogger().logger,
    counter: { add: (n, attributes) => counted.push(attributes.outcome) },
  });
  await publish([{ to: { profile: PROFILE }, type: 'tips.changed' }]);
  assert.deepEqual(sent, [
    ['w:live:v1', `{"to":{"profile":"${PROFILE}"},"type":"tips.changed"}`],
  ]);
  assert.deepEqual(counted, ['ok']);
  await publish([]);
  assert.equal(sent.length, 1);
});
