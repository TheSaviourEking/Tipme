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
  announcementSignals,
  businessTipSignals,
  expiredTipSignals,
  jobSignalsFor,
  liveSignalFor,
  reconcileIssueSignals,
  requestGate,
  signalProvidersAfter,
  whenRequestMoved,
} from '../dist/live-signals.js';

const PROFILE = '22222222-2222-4222-8222-222222222222';
const TIP = '55555555-5555-4555-8555-555555555555';

test('tip.succeeded and tip.failed map to tips.changed for their profile', () => {
  for (const type of ['tip.succeeded', 'tip.failed'])
    assert.deepEqual(
      liveSignalFor(type, { tipId: TIP, profileId: PROFILE })[0],
      { to: { profile: PROFILE }, type: 'tips.changed' },
    );
});

test('a paid or failed tip also reaches its receipt', () => {
  for (const type of ['tip.succeeded', 'tip.failed']) {
    assert.deepEqual(liveSignalFor(type, { tipId: TIP, profileId: PROFILE }), [
      { to: { profile: PROFILE }, type: 'tips.changed' },
      { to: { tip: TIP }, type: 'tip.changed' },
    ]);
    // Without a valid tip id, only the recipient's signal; without a profile, only the receipt's.
    assert.deepEqual(
      liveSignalFor(type, { tipId: 'nope', profileId: PROFILE }),
      [{ to: { profile: PROFILE }, type: 'tips.changed' }],
    );
    assert.deepEqual(liveSignalFor(type, { tipId: TIP }), [
      { to: { tip: TIP }, type: 'tip.changed' },
    ]);
  }
});

test('stale tips the expiry cancelled each signal their receipt', () => {
  const other = '88888888-8888-4888-8888-888888888888';
  assert.deepEqual(expiredTipSignals([TIP, other, 'junk']), [
    { to: { tip: TIP }, type: 'tip.changed' },
    { to: { tip: other }, type: 'tip.changed' },
  ]);
  assert.deepEqual(expiredTipSignals([]), []);
  for (const message of expiredTipSignals([TIP]))
    assert.notEqual(parseLiveMessage(JSON.stringify(message)), null);
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

// PR 2: withdrawals, the switch, freezes, payout account setup and weekly reports.

test('payout.paid and payout.failed map to withdrawals.changed for the profile', () => {
  for (const type of ['payout.paid', 'payout.failed'])
    assert.deepEqual(
      liveSignalFor(type, { payoutId: TIP, profileId: PROFILE }),
      [{ to: { profile: PROFILE }, type: 'withdrawals.changed' }],
      type,
    );
});

test('a takeover freeze maps to withdrawals.changed for that page only', () => {
  assert.deepEqual(
    liveSignalFor(WITHDRAWAL_FREEZE_OPENED_EVENT, {
      issueId: TIP,
      profileId: PROFILE,
    }),
    [{ to: { profile: PROFILE }, type: 'withdrawals.changed' }],
  );
});

test('the withdrawals switch broadcasts to all', () => {
  for (const state of ['off', 'on'])
    assert.deepEqual(liveSignalFor(WITHDRAWALS_SWITCH_EVENT, { state }), [
      { to: { all: true }, type: 'withdrawals.changed' },
    ]);
});

test('freeze_released uses the new profileId and maps to [] without it', () => {
  const payload = {
    action: 'freeze_released',
    outcome: 'released',
    targetId: TIP,
    requestedBy: TIP,
  };
  assert.deepEqual(
    liveSignalFor('ops.freeze_released', { ...payload, profileId: PROFILE }),
    [{ to: { profile: PROFILE }, type: 'withdrawals.changed' }],
  );
  assert.deepEqual(liveSignalFor('ops.freeze_released', payload), []);
});

test('a payout start that changed the payout signals its profile; one that changed nothing does not', () => {
  const data = { payoutId: TIP, profileId: PROFILE };
  for (const outcome of ['started', 'failed', 'uncertain'])
    assert.deepEqual(
      jobSignalsFor(PAYOUT_START_EVENT, outcome, data),
      [{ to: { profile: PROFILE }, type: 'withdrawals.changed' }],
      outcome,
    );
  for (const outcome of [
    'already',
    'held',
    'switched_off',
    'waiting_on_platform',
  ])
    assert.deepEqual(
      jobSignalsFor(PAYOUT_START_EVENT, outcome, data),
      [],
      outcome,
    );
  assert.deepEqual(jobSignalsFor(PAYOUT_START_EVENT, 'started', {}), []);
});

test('the payout setup sweep gives payments.changed for each changed profile', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  assert.deepEqual(
    jobSignalsFor('payment-accounts.payout-setup', 'swept', {
      profileIds: [PROFILE, OTHER, 'nope'],
    }),
    [
      { to: { profile: PROFILE }, type: 'payments.changed' },
      { to: { profile: OTHER }, type: 'payments.changed' },
    ],
  );
  assert.deepEqual(
    jobSignalsFor('payment-accounts.payout-setup', 'swept', { profileIds: [] }),
    [],
  );
  assert.deepEqual(
    jobSignalsFor('payment-accounts.payout-setup', 'skipped', {
      profileIds: [PROFILE],
    }),
    [],
  );
});

test('jobSignalsFor reports.weekly gives reports.changed and notifications.changed per profile id', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  assert.deepEqual(
    jobSignalsFor('reports.weekly', 'reported', {
      profileIds: [PROFILE, OTHER],
    }),
    [
      { to: { profile: PROFILE }, type: 'reports.changed' },
      { to: { profile: PROFILE }, type: 'notifications.changed' },
      { to: { profile: OTHER }, type: 'reports.changed' },
      { to: { profile: OTHER }, type: 'notifications.changed' },
    ],
  );
  assert.deepEqual(jobSignalsFor('reports.weekly', 'reported', {}), []);
  for (const m of jobSignalsFor('reports.weekly', 'reported', {
    profileIds: [PROFILE],
  }))
    assert.deepEqual(parseLiveMessage(JSON.stringify(m)), m);
});

test('a paid tip signals business.changed to each user the business audience names', async () => {
  const asked = [];
  const users = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const signals = await businessTipSignals(
    { tipId: TIP, profileId: PROFILE },
    async (ref) => {
      asked.push(ref);
      return users;
    },
  );
  assert.deepEqual(asked, [{ tipId: TIP }]);
  assert.deepEqual(signals, [
    { to: { user: users[0] }, type: 'business.changed' },
    { to: { user: users[1] }, type: 'business.changed' },
  ]);
});

test('a tip with no valid id, or a lookup that fails, signals nothing', async () => {
  let asked = 0;
  const audience = async () => {
    asked += 1;
    throw new Error('down');
  };
  assert.deepEqual(await businessTipSignals({ tipId: 'nope' }, audience), []);
  assert.equal(asked, 0);
  assert.deepEqual(await businessTipSignals({ tipId: TIP }, audience), []);
});

// Per-provider balances, Task 9: a request paid as parts is one withdrawal on the person's page, so
// a part's paid event or start signals only once its request has moved as a whole.
test('a paid part and a started part wait for their request; a failure never does', () => {
  const data = { payoutId: TIP, profileId: PROFILE };
  assert.deepEqual(requestGate('payout.paid', null, data), {
    payoutId: TIP,
    after: 'settled',
  });
  for (const outcome of ['started', 'uncertain'])
    assert.deepEqual(requestGate(PAYOUT_START_EVENT, outcome, data), {
      payoutId: TIP,
      after: 'started',
    });
  // A failed part puts its money back in the balance: the page always re-reads.
  assert.equal(requestGate('payout.failed', null, data), null);
  assert.equal(requestGate(PAYOUT_START_EVENT, 'failed', data), null);
  assert.equal(requestGate('tip.succeeded', null, data), null);
  assert.equal(requestGate('payout.paid', null, {}), null);
  assert.equal(requestGate('payout.paid', null, { payoutId: 'x' }), null);
});

test('whenRequestMoved keeps the signals only when the request moved', async () => {
  const messages = [{ to: { profile: PROFILE }, type: 'withdrawals.changed' }];
  const gate = { payoutId: TIP, after: 'settled' };
  const asked = [];
  const due = (answer) => async (input) => {
    asked.push(input);
    return answer;
  };
  assert.deepEqual(await whenRequestMoved(messages, gate, due(true)), messages);
  assert.deepEqual(await whenRequestMoved(messages, gate, due(false)), []);
  assert.deepEqual(asked, [gate, gate]);
  // No gate: as before, without asking.
  assert.deepEqual(
    await whenRequestMoved(messages, null, due(false)),
    messages,
  );
  assert.equal(asked.length, 2);
  // Nothing to send: nothing asked.
  assert.deepEqual(await whenRequestMoved([], gate, due(true)), []);
  assert.equal(asked.length, 2);
  // A check that fails sends the signal: it is only a prompt to re-read.
  assert.deepEqual(
    await whenRequestMoved(messages, gate, async () => {
      throw new Error('down');
    }),
    messages,
  );
});

test('staff changes re-check every staff stream', () => {
  for (const name of [
    'ops.staff_changed',
    'ops.last_approver_removed',
    // Any path that ended someone's admin grants (dropOpsAccess): reset, resend, removal, a move.
    'ops.grants_ended',
  ])
    assert.deepEqual(
      liveSignalFor(name, { action: 'role_changed', requestedBy: null }),
      [{ to: { staff: 'any' }, type: 'staff.changed' }],
      name,
    );
});

test('approval events reach every staff stream', () => {
  for (const name of [
    'ops.approval_pending',
    'ops.approval_ran',
    'ops.approval_closed',
  ])
    assert.deepEqual(liveSignalFor(name, { requestId: TIP }), [
      { to: { staff: 'any' }, type: 'ops.approvals.changed' },
    ]);
});

test('an opened issue reaches issues staff', () => {
  for (const name of DOMAIN_EVENT_NAMES)
    assert.deepEqual(jobSignalsFor(name, 'issue_opened', { tipId: TIP }), [
      { to: { staff: 'issues.view' }, type: 'ops.issues.changed' },
    ]);
  // Only an issue that opened counts: a duplicate or a logged event changed nothing.
  for (const outcome of ['duplicate', 'logged', 'skipped'])
    assert.deepEqual(jobSignalsFor('payment.unresolved', outcome, {}), []);
});

test('a reconcile that opened or resolved nothing signals nothing', () => {
  assert.deepEqual(reconcileIssueSignals({ opened: 0, resolved: 0 }), []);
  for (const counts of [
    { opened: 1, resolved: 0 },
    { opened: 0, resolved: 2 },
  ])
    assert.deepEqual(reconcileIssueSignals(counts), [
      { to: { staff: 'issues.view' }, type: 'ops.issues.changed' },
    ]);
});

test('a queued batch signals announcement staff; idle and paused do not', () => {
  assert.deepEqual(announcementSignals('announcements_queued'), [
    { to: { staff: 'announcements.send' }, type: 'ops.announcements.changed' },
  ]);
  for (const outcome of ['announcements_idle', 'announcements_paused'])
    assert.deepEqual(announcementSignals(outcome), []);
});

const PROVIDERS = {
  to: { staff: ['issues.view', 'providers.manage'] },
  type: 'ops.providers.changed',
};

test('a mail health change signals providers staff after the alert', async () => {
  const order = [];
  const onChange = signalProvidersAfter(
    async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`alert ${event.change}`);
    },
    async (messages) => void order.push(messages),
  );
  await onChange({ provider: 'zeptomail', change: 'tripped' });
  assert.deepEqual(order, ['alert tripped', [PROVIDERS]]);
});

test('an alert that fails still signals, and the failure still reaches the breaker', async () => {
  const published = [];
  const onChange = signalProvidersAfter(
    async () => {
      throw new Error('webhook down');
    },
    async (messages) => void published.push(messages),
  );
  // The breaker logs a failed alert (mail.health_alert_failed): the rejection is passed on.
  await assert.rejects(
    onChange({ provider: 'zeptomail', change: 'recovered' }),
    /webhook down/,
  );
  assert.deepEqual(published, [[PROVIDERS]]);
});
