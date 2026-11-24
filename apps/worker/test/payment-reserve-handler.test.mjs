import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  warnIfNoAlertRoute,
  webhookAlert,
} from '../dist/handlers/payment-reserve.js';
import {
  ensureReserveSchedules,
  removeLeftoverReserveSchedules,
  reserveChecks,
  workerPaymentProviders,
} from '../dist/job-worker.js';
import { SCHEDULED_RUN_RETENTION } from '../dist/ensure-schedule.js';

const URL_WITH_SECRET =
  'https://hooks.example.test/services/T0/B0/very-secret-token';

test('the alert is posted as {"text": ...} to the alert route', async () => {
  const calls = [];
  const alert = webhookAlert({
    url: URL_WITH_SECRET,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    },
  });
  await alert('Payment reserve is low');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_WITH_SECRET);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: 'Payment reserve is low',
  });
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  // A redirect could carry the text somewhere else.
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('a failed alert throws an error that does not contain the route address', async () => {
  const failures = [
    async () => {
      throw new TypeError(`fetch failed: ${URL_WITH_SECRET}`);
    },
    async () => new Response('nope', { status: 500 }),
    async () => new Response('gone', { status: 404 }),
  ];
  for (const fetchImpl of failures) {
    const alert = webhookAlert({ url: URL_WITH_SECRET, fetchImpl });
    await assert.rejects(
      () => alert('x'),
      (error) =>
        error instanceof Error &&
        !String(error.message).includes('very-secret-token') &&
        !String(error.stack).includes('very-secret-token') &&
        !String(error.cause ?? '').includes('very-secret-token'),
    );
  }
});

test('with no alert route the text goes to the log and the alert is refused, so it is not counted as sent', async () => {
  const entries = [];
  const alert = webhookAlert({
    url: undefined,
    log: (entry) => entries.push(entry),
  });
  await assert.rejects(() => alert('Payment reserve is low'), {
    message: 'alert_route_missing',
  });
  assert.deepEqual(entries, [
    { event: 'reserve.alert_unrouted', text: 'Payment reserve is low' },
  ]);
});

test('one startup warning names the missing setting, and nothing else, when there is no alert route', () => {
  const entries = [];
  warnIfNoAlertRoute(undefined, (entry) => entries.push(entry));
  assert.deepEqual(entries, [
    { event: 'reserve.no_alert_route', setting: 'ALERT_WEBHOOK_URL' },
  ]);
  const quiet = [];
  warnIfNoAlertRoute('https://hooks.example.test/services/T0/B0/token', (e) =>
    quiet.push(e),
  );
  assert.deepEqual(quiet, []);
});

// Per-provider balances (Task 4): one reserve check per connected-account provider in either role.
const fakeRedis = {};
const scheduler = () => {
  const upserts = [];
  return {
    upserts,
    queue: {
      upsertJobScheduler: async (id, repeat, template) => {
        upserts.push({ id, repeat, template });
      },
    },
  };
};
const quiet = { warn: () => undefined };

test('a withdraw-only Bachs gets its own reserve schedule with run retention', async () => {
  const providers = workerPaymentProviders(
    {
      PAYMENT_PROVIDER: 'mock',
      PAYMENT_WITHDRAW_ONLY_PROVIDERS: ['bachs-sandbox'],
      BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
      QUEUE_PREFIX: 'tipme-test',
    },
    fakeRedis,
  );
  const checks = reserveChecks(providers);
  assert.deepEqual(
    checks.map((c) => [c.id, c.provider.name, c.active]),
    [['payments.reserve.bachs.sandbox', 'bachs-sandbox', false]],
  );
  const { queue, upserts } = scheduler();
  const schedules = ensureReserveSchedules({ queue, logger: quiet }, checks);
  await Promise.all(schedules.map((s) => s.ready));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].id, 'payments.reserve.bachs.sandbox');
  assert.deepEqual(upserts[0].repeat, { every: 15 * 60_000 });
  assert.deepEqual(upserts[0].template, {
    name: 'payments.reserve.bachs.sandbox',
    opts: SCHEDULED_RUN_RETENTION,
  });
  assert.deepEqual(SCHEDULED_RUN_RETENTION, {
    removeOnComplete: true,
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  await Promise.all(schedules.map((s) => s.stop()));
});

test('the active Bachs keeps the payments.reserve schedule; a mock-only copy has none', async () => {
  const active = reserveChecks(
    workerPaymentProviders(
      {
        PAYMENT_PROVIDER: 'bachs-sandbox',
        PAYMENT_WITHDRAW_ONLY_PROVIDERS: ['mock_alt'],
        BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
        QUEUE_PREFIX: 'tipme-test',
      },
      fakeRedis,
    ),
  );
  assert.deepEqual(
    active.map((c) => [c.id, c.provider.name, c.active]),
    [['payments.reserve', 'bachs-sandbox', true]],
  );
  const { queue, upserts } = scheduler();
  await Promise.all(
    ensureReserveSchedules({ queue, logger: quiet }, active).map(
      (s) => s.ready,
    ),
  );
  assert.deepEqual(upserts[0].template.opts, SCHEDULED_RUN_RETENTION);
  // A mock copy's legacy sandbox reader (P11) reads old tips only: no reserve check for it.
  assert.deepEqual(
    reserveChecks(
      workerPaymentProviders(
        {
          PAYMENT_PROVIDER: 'mock',
          PAYMENT_WITHDRAW_ONLY_PROVIDERS: [],
          BACHS_SANDBOX_API_KEY: 'sk_sandbox_x',
          QUEUE_PREFIX: 'tipme-test',
        },
        fakeRedis,
      ),
    ),
    [],
  );
});

test('reserve schedules left from an earlier configuration are removed at startup', async () => {
  const removed = [];
  const queue = {
    getJobSchedulers: async () => [
      { key: 'payments.reserve', name: 'payments.reserve' },
      {
        key: 'payments.reserve.bachs.sandbox',
        name: 'payments.reserve.bachs.sandbox',
      },
      {
        key: 'payments.reserve.bachs.live',
        name: 'payments.reserve.bachs.live',
      },
      { key: 'reconcile.payments', name: 'reconcile.payments' },
      { key: 'payments.reserved-words', name: 'payments.reserved-words' },
    ],
    removeJobScheduler: async (id) => {
      removed.push(id);
      return true;
    },
  };
  const kept = await removeLeftoverReserveSchedules(
    { queue, logger: quiet },
    new Set(['payments.reserve.bachs.sandbox']),
  );
  assert.deepEqual(removed.sort(), [
    'payments.reserve',
    'payments.reserve.bachs.live',
  ]);
  assert.equal(kept, 2);
});

test('a failed clean-up is logged, never fatal', async () => {
  const warnings = [];
  const removed = await removeLeftoverReserveSchedules(
    {
      queue: {
        getJobSchedulers: async () => {
          throw new Error('redis down');
        },
        removeJobScheduler: async () => true,
      },
      logger: { warn: (entry) => warnings.push(entry) },
    },
    new Set(),
  );
  assert.equal(removed, 0);
  assert.deepEqual(warnings, [{ event: 'reserve.schedule_cleanup_failed' }]);
});
