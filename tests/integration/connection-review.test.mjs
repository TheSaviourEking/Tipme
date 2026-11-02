import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { sql } from '../../packages/database/node_modules/drizzle-orm/index.js';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  createDatabase,
  createPaymentIntent,
  createQuote,
  guarded,
  isDatabaseAvailabilityFailure,
  mailSealing,
  markAttemptInitiated,
  notifyTipSucceeded,
  recordProviderEvent,
  seedDemoProfiles,
  staffLockWaitersAllowed,
} from '../../packages/database/dist/index.js';
import { runMigrations } from '../../packages/database/dist/migrations.js';
import { jobFailure } from '../../apps/worker/dist/job-retry.js';
import { startPgGate } from './pg-gate.mjs';
import { browserHeaders, opsSignIn, startStack } from './helpers.mjs';

// Findings from the connection budget's review, against real connections.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});
const STAFF_LOCK = `SELECT pg_advisory_xact_lock(hashtext('tipme.staff-admin'))`;
const REASON = 'Testing the stop actions in an incident';
let database;
let stack;
let owner;

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  await database.pool.query(
    'CREATE TABLE IF NOT EXISTS budget_probe (id text)',
  );
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { DATABASE_POOL_MAX: '1' },
    workerEnv: { DATABASE_POOL_MAX: '1' },
  });
  owner = await opsSignIn(stack.api, database.db, '+2348036661001');
});
after(async () => {
  await stack.stop();
  await database.pool.query('DROP TABLE IF EXISTS budget_probe');
  await database.close();
});

const post = (path, body) =>
  fetch(`${stack.api}${path}`, {
    method: 'POST',
    headers: browserHeaders(owner.cookie),
    body: JSON.stringify(body),
  });
const rows = (text, params) =>
  database.pool.query(text, params).then((result) => result.rows);
const page = () =>
  fetch(`${stack.api}/v1/profiles/ada`, {
    signal: AbortSignal.timeout(4000),
  }).then((response) => response.status);

test('waiters follow the pool: none at one connection, one less than the pool, at most three', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 10].map(staffLockWaitersAllowed),
    [0, 1, 2, 3, 3, 3],
  );
});

test('at pool 1 a busy staff lock refuses at once, public pages stay up, and stop actions work first time', async () => {
  const [ada] = await rows(
    `SELECT id, user_id FROM profiles WHERE handle_lower = 'ada'`,
  );
  const holder = await database.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(STAFF_LOCK);
    const asked = Array.from({ length: 4 }, (_, i) =>
      post('/v1/ops/staff/roles', {
        name: `Pool one role ${i} ${randomUUID().slice(0, 6)}`,
        reason: 'Queueing on the lock at pool one',
        permissions: [],
      }),
    );
    const started = performance.now();
    const answers = await Promise.all(asked);
    assert.ok(
      performance.now() - started < 2000,
      'a refusal must not hold the only connection for the lock wait',
    );
    for (const answer of answers) {
      assert.equal(answer.status, 503);
      assert.equal((await answer.json()).error.code, 'STAFF_ADMIN_BUSY');
    }
    for (let i = 0; i < 4; i += 1) assert.equal(await page(), 200);

    // With the staff lock still held, each stop action works on its first try.
    const off = await post('/v1/ops/withdrawals-switch', {
      paused: true,
      reason: REASON,
    });
    assert.equal(off.status, 200);
    const freeze = await post(`/v1/ops/pages/${ada.id}/withdrawal-freeze`, {
      reason: REASON,
    });
    assert.equal(freeze.status, 200);
    const ended = await post(`/v1/ops/accounts/${ada.user_id}/end-sessions`, {
      reason: REASON,
    });
    assert.equal(ended.status, 200);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  // Retryable: nothing changed, and the same request goes through once the lock is free.
  const retried = await post('/v1/ops/staff/roles', {
    name: `Pool one retry ${randomUUID().slice(0, 6)}`,
    reason: 'Retrying after the lock was freed',
    permissions: [],
  });
  assert.ok(retried.status < 300, String(retried.status));
});

test('every pool asks for keepalive and gives an abandoned transaction a server-side limit', async () => {
  const handle = createDatabase(database.url);
  try {
    assert.equal(handle.pool.options.keepAlive, true);
    assert.equal(handle.pool.options.keepAliveInitialDelayMillis, 10_000);
    assert.equal(handle.pool.options.query_timeout, undefined);
    const { rows: shown } = await handle.pool.query(
      'SHOW idle_in_transaction_session_timeout',
    );
    assert.equal(shown[0].idle_in_transaction_session_timeout, '1min');
  } finally {
    await handle.close();
  }
});

test('a transaction left idle past the limit is rolled back and reads as retryable', async () => {
  const handle = createDatabase(database.url, { idleInTransactionMillis: 200 });
  const key = `idle.${randomUUID()}`;
  try {
    const error = await guarded(() =>
      handle.db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO budget_probe (id) VALUES (${key})`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await tx.execute(sql`SELECT 1`);
      }),
    ).catch((caught) => caught);
    assert.equal(isDatabaseAvailabilityFailure(error), true, error?.message);
    assert.deepEqual(
      await rows('SELECT id FROM budget_probe WHERE id = $1', [key]),
      [],
    );
  } finally {
    await handle.close();
  }
});

test('a backend terminated between statements is retryable for a job, and nothing was kept', async () => {
  const handle = createDatabase(database.url, { max: 1 });
  const key = `lost.${randomUUID()}`;
  try {
    const error = await guarded(() =>
      handle.db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO budget_probe (id) VALUES (${key})`);
        const { rows: me } = await tx.execute(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        await rows('SELECT pg_terminate_backend($1)', [me[0].pid]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await tx.execute(sql`SELECT 1`);
      }),
    ).catch((caught) => caught);
    assert.equal(error.failure?.kind, 'connection_lost', error.message);
    assert.equal(isDatabaseAvailabilityFailure(error), true);
    assert.equal(jobFailure('tip.succeeded', error), error);
    assert.equal(jobFailure('payout.start', error), error);
    assert.deepEqual(
      await rows('SELECT id FROM budget_probe WHERE id = $1', [key]),
      [],
    );
  } finally {
    await handle.close();
  }
});

test('a BEGIN that fails gives its connection back: the only slot is not lost for good', async () => {
  const handle = createDatabase(database.url, {
    max: 1,
    connectionTimeoutMillis: 500,
  });
  try {
    await handle.pool.query('SELECT 1');
    handle.pool.once('acquire', (client) => client.connection.stream.destroy());
    const error = await handle.db
      .transaction(async () => undefined)
      .catch((caught) => caught);
    assert.equal(isDatabaseAvailabilityFailure(error), true, String(error));
    assert.equal(
      await handle.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
        return 'works';
      }),
      'works',
    );
  } finally {
    await handle.close();
  }
});

test('tip.succeeded retried after a lost connection tells the recipient exactly once', async () => {
  const quote = await createQuote(database.db, {
    handle: 'tobi',
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `ref_${randomUUID()}`;
  await markAttemptInitiated(database.db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 100000n,
    currency: 'NGN',
    providerFeeMinor: 0n,
    signatureVerified: true,
    payload: {},
  });
  const [{ profile_id: profileId }] = await rows(
    'SELECT profile_id FROM tips WHERE id = $1',
    [intent.tipId],
  );
  // The worker may also handle the real event: count only that this one tip ends up once.
  const sealing = mailSealing(Buffer.alloc(32, 7));
  const gate = await startPgGate(database.url);
  const handle = createDatabase(gate.url, { max: 1 });
  try {
    gate.fill();
    const failed = await notifyTipSucceeded(handle.db, {
      sealing,
      tipId: intent.tipId,
      profileId,
    }).catch((caught) => caught);
    assert.equal(isDatabaseAvailabilityFailure(failed), true);
    gate.drain();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await notifyTipSucceeded(handle.db, {
      sealing,
      tipId: intent.tipId,
      profileId,
    });
    assert.equal(
      await notifyTipSucceeded(handle.db, {
        sealing,
        tipId: intent.tipId,
        profileId,
      }),
      'duplicate',
    );
    const notices = await rows(
      'SELECT id FROM notifications WHERE tip_id = $1',
      [intent.tipId],
    );
    assert.equal(notices.length, 1);
  } finally {
    await handle.close();
    await gate.close();
  }
});

test('a migration stuck behind a table lock fails cleanly, leaves nothing, and succeeds later', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'tipme-migration-'));
  mkdirSync(join(folder, 'meta'));
  const tag = `0000_budget_${randomUUID().slice(0, 6).replace(/-/g, '_')}`;
  writeFileSync(
    join(folder, `${tag}.sql`),
    'ALTER TABLE withdrawals_switch ADD COLUMN lock_probe boolean;',
  );
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [
        {
          idx: 0,
          version: '7',
          when: Date.now() + 1e10,
          tag,
          breakpoints: true,
        },
      ],
    }),
  );
  const handle = createDatabase(database.url, {
    max: 1,
    lockTimeoutMillis: 200,
  });
  const holder = await database.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE withdrawals_switch IN SHARE MODE');
    const error = await runMigrations(handle.db, folder).catch((e) => e);
    assert.match(String(error?.cause?.code ?? error?.code), /55P03/);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  const column = () =>
    rows(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'withdrawals_switch' AND column_name = 'lock_probe'`,
    );
  assert.equal((await column()).length, 0);
  try {
    await runMigrations(handle.db, folder);
    assert.equal((await column()).length, 1);
  } finally {
    await rows('ALTER TABLE withdrawals_switch DROP COLUMN lock_probe');
    await rows(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at > $1`,
      [Date.now()],
    );
    await handle.close();
  }
});
