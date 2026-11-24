import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  createPaymentIntent,
  createQuote,
  markAttemptInitiated,
  reconcileAttempts,
  reconcilePayouts,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

const { createMockProvider } = await import('../../../payments/dist/index.js');
const { Redis } = createRequire(
  new URL('../../../payments/package.json', import.meta.url),
)('ioredis');

test('reconciliation', async (t) => {
  const database = await useDatabase(t);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  t.after(() => redis.quit());
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);
  let mock;
  const freshMock = () => {
    mock = createMockProvider({
      redis,
      secret: 'x'.repeat(32),
      prefix: `r-${randomUUID().slice(0, 8)}`,
    });
    let initialised = 0;
    const original = mock.initializePayment.bind(mock);
    mock.initializePayment = async (input) => {
      initialised += 1;
      return original(input);
    };
    mock.initialisedCount = () => initialised;
    return mock;
  };
  const initiated = async ({ scenario = 'succeed', status } = {}) => {
    const { quoteId } = await createQuote(database.db, {
      handle: 'ada',
      tipMinor: 200000n,
      currency: 'NGN',
    });
    const { tipId, attemptId } = await createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
    });
    const { providerReference } = await mock.initializePayment({
      attemptId,
      amountMinor: 200000n,
      currency: 'NGN',
      scenario,
    });
    if (status) await mock.markStatus(providerReference, status);
    await markAttemptInitiated(database.db, {
      attemptId,
      provider: 'mock',
      providerReference,
    });
    return { tipId, attemptId, providerReference };
  };
  const tipStatus = async (tipId) =>
    (await q('SELECT status FROM tips WHERE id = $1', [tipId]))[0].status;
  const later = (minutes) => new Date(Date.now() + minutes * 60_000);

  await t.test(
    'a captured payment the provider never reported is recorded once',
    async () => {
      await database.fresh();
      freshMock();
      const { tipId } = await initiated({ scenario: 'no-reply' });
      const before = mock.initialisedCount();
      assert.deepEqual(
        await reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(3),
          minAgeMs: 120_000,
        }),
        { checked: 1, applied: 1, unresolved: 0, errors: 0, errorKinds: {} },
      );
      assert.equal(await tipStatus(tipId), 'SUCCEEDED');
      assert.deepEqual(
        await reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(4),
          minAgeMs: 120_000,
        }),
        { checked: 0, applied: 0, unresolved: 0, errors: 0, errorKinds: {} },
      );
      assert.equal(
        mock.initialisedCount(),
        before,
        'reconciliation never starts a payment',
      );
    },
  );

  await t.test(
    'two reconcilers at once book the payment exactly once',
    async () => {
      await database.fresh();
      freshMock();
      const { attemptId } = await initiated({ scenario: 'no-reply' });
      await Promise.all([
        reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(3),
          minAgeMs: 120_000,
        }),
        reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(3),
          minAgeMs: 120_000,
        }),
      ]);
      assert.equal(
        (
          await q(
            `SELECT count(*)::int AS n FROM ledger_transactions WHERE operation_key = $1`,
            [`payment.${attemptId}`],
          )
        )[0].n,
        1,
      );
    },
  );

  await t.test(
    'attempts that can never resolve do not starve newer ones',
    async () => {
      await database.fresh();
      freshMock();
      for (let i = 0; i < 3; i++)
        await initiated({ scenario: 'wrong-amount', status: 'succeeded' });
      // Wrong-amount attempts first hear a mismatch, then stay UNKNOWN forever.
      await reconcileAttempts({
        db: database.db,
        provider: mock,
        now: later(3),
        minAgeMs: 120_000,
        limit: 2,
      });
      const { tipId } = await initiated({ scenario: 'no-reply' });
      for (let run = 0; run < 3; run++) {
        await reconcileAttempts({
          db: database.db,
          provider: mock,
          now: later(5 + run),
          minAgeMs: 0,
          limit: 2,
        });
      }
      assert.equal(await tipStatus(tipId), 'SUCCEEDED');
    },
  );

  await t.test(
    'one attempt that always fails to check does not stop the others',
    async () => {
      await database.fresh();
      freshMock();
      const broken = await initiated();
      const { tipId } = await initiated({ scenario: 'no-reply' });
      const flaky = {
        verifyTransaction: async (reference) => {
          if (reference === broken.providerReference)
            throw Object.assign(new Error('no response'), {
              name: 'BachsTransportError',
            });
          return mock.verifyTransaction(reference);
        },
      };
      const result = await reconcileAttempts({
        db: database.db,
        provider: flaky,
        now: later(3),
        minAgeMs: 120_000,
      });
      assert.equal(result.errors, 1);
      // Counted by kind, so the worker's log says why (never which attempt or how much).
      assert.deepEqual(result.errorKinds, { BachsTransportError: 1 });
      assert.equal(result.applied, 1);
      assert.equal(await tipStatus(tipId), 'SUCCEEDED');
    },
  );

  await t.test(
    'pending payments are left alone; young attempts are skipped',
    async () => {
      await database.fresh();
      freshMock();
      const { tipId } = await initiated();
      assert.equal(
        (
          await reconcileAttempts({
            db: database.db,
            provider: mock,
            now: new Date(),
            minAgeMs: 120_000,
          })
        ).checked,
        0,
      );
      assert.equal(
        (
          await reconcileAttempts({
            db: database.db,
            provider: mock,
            now: later(3),
            minAgeMs: 120_000,
          })
        ).applied,
        0,
      );
      assert.equal(await tipStatus(tipId), 'AWAITING_PAYMENT');
    },
  );

  await t.test(
    'a payout start with no answer and no lookup goes to staff once, and stays reserved',
    async () => {
      await database.fresh();
      const payoutId = randomUUID();
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                              request_fingerprint, provider, start_uncertain_at, created_at)
         VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'f', 'bachs',
                 now() - interval '2 hours', now() - interval '2 hours')`,
        [payoutId, ADA, randomUUID()],
      );
      const verifier = {
        fetchPayoutStatus: async () => ({ status: 'pending' }),
      };
      for (let run = 0; run < 2; run += 1)
        await reconcilePayouts({
          db: database.db,
          provider: verifier,
          now: new Date(),
          minAgeMs: 0,
        });
      assert.equal(
        (await q(`SELECT 1 FROM issues WHERE kind = 'payout_unresolved'`))
          .length,
        1,
      );
      assert.equal(
        (await q('SELECT status FROM payouts WHERE id = $1', [payoutId]))[0]
          .status,
        'REQUESTED',
      );
    },
  );

  await t.test(
    'a queued payout that never started goes to staff, unless a hold explains it',
    async () => {
      await database.fresh();
      const payoutId = randomUUID();
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                              request_fingerprint, provider, created_at)
         VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'f', 'bachs', now() - interval '2 hours')`,
        [payoutId, ADA, randomUUID()],
      );
      const issueId = randomUUID();
      await q(
        `INSERT INTO issues (id, kind, dedupe_key, severity, subject, summary, opened_at)
         VALUES ($1, 'payment_reversed', $2, 'money', '{}', 'test', now())`,
        [issueId, `test.${issueId}`],
      );
      await q(
        `INSERT INTO withdrawal_holds (id, profile_id, reason, issue_id) VALUES ($1, $2, 'reversal', $3)`,
        [randomUUID(), ADA, issueId],
      );
      const verifier = {
        fetchPayoutStatus: async () => ({ status: 'pending' }),
      };
      const run = () =>
        reconcilePayouts({
          db: database.db,
          provider: verifier,
          now: new Date(),
          minAgeMs: 0,
        });
      const unresolved = async () =>
        (await q(`SELECT 1 FROM issues WHERE kind = 'payout_unresolved'`))
          .length;
      await run();
      assert.equal(await unresolved(), 0);
      await q(`UPDATE withdrawal_holds SET released_at = now()`);
      await run();
      assert.equal(await unresolved(), 1);
    },
  );

  await t.test(
    'a payout with no mark but a recorded step says which step it reached',
    async () => {
      await database.fresh();
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                              request_fingerprint, provider, start_step, created_at)
         VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'f', 'bachs', 'payout', now() - interval '2 hours')`,
        [randomUUID(), ADA, randomUUID()],
      );
      await reconcilePayouts({
        db: database.db,
        provider: { fetchPayoutStatus: async () => ({ status: 'pending' }) },
        now: new Date(),
        minAgeMs: 0,
      });
      const [issue] = await q(
        `SELECT summary FROM issues WHERE kind = 'payout_unresolved'`,
      );
      assert.match(issue.summary, /payout itself/);
    },
  );

  await t.test(
    'a payment the provider cannot find for 30 minutes raises one alert',
    async () => {
      await database.fresh();
      freshMock();
      const { attemptId } = await initiated();
      await q(
        `UPDATE payment_attempts SET provider_reference = 'mock_pay_missing' WHERE id = $1`,
        [attemptId],
      );
      const first = await reconcileAttempts({
        db: database.db,
        provider: mock,
        now: later(31),
        minAgeMs: 120_000,
      });
      await reconcileAttempts({
        db: database.db,
        provider: mock,
        now: later(32),
        minAgeMs: 120_000,
      });
      assert.equal(first.unresolved, 1);
      const alerts = await q(
        `SELECT dedupe_key FROM outbox_events WHERE event_type = 'payment.unresolved'`,
      );
      assert.equal(alerts.length, 1);
    },
  );
  await t.test(
    'parked payout events are rechecked through their own provider',
    async () => {
      await database.fresh();
      // Three payouts already with their providers, each with a signed event that arrived before
      // its reference was recorded (parked). Created just now, so only the parked sweep reads them.
      const parkedFor = async (provider, reference) => {
        const payoutId = randomUUID();
        await q(
          `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                                request_fingerprint, provider, provider_reference, account_reference)
           VALUES ($1, $2, 'NGN', 100000, 'PROCESSING', $3, 'f', $4, $5, 'acct_1')`,
          [payoutId, ADA, randomUUID(), provider, reference],
        );
        const unmatchedId = randomUUID();
        await q(
          `INSERT INTO unmatched_provider_events
             (id, provider, provider_event_id, event_type, payload_hash, payload, reason)
           VALUES ($1, $2, $3, 'payout.paid', 'h', $4, 'unknown_payout')`,
          [
            unmatchedId,
            provider,
            `evt_${reference}`,
            JSON.stringify({
              providerReference: reference,
              accountReference: 'acct_1',
              status: 'paid',
              // A contradicted event is applied only on a read: that read shows which provider.
              contradicted: true,
            }),
          ],
        );
        return { payoutId, unmatchedId };
      };
      const alt = await parkedFor('mock_alt', 'mock_alt_out_1');
      const bachs = await parkedFor('bachs', 'bachs_ref_1');
      const unlisted = await parkedFor('mock', 'mock_out_1');
      const asked = { mock_alt: [], bachs: [], mock: [] };
      const readerFor = (name) => ({
        fetchPayoutStatus: async (reference) => {
          asked[name].push(reference);
          return { status: 'paid' };
        },
      });
      const resolver = (name) => {
        if (!(name in asked))
          throw new Error('Unsupported persisted payment provider');
        return readerFor(name);
      };
      await reconcilePayouts({
        db: database.db,
        provider: resolver,
        parkedProviders: ['mock_alt', 'bachs'],
        now: new Date(),
        minAgeMs: 3_600_000,
      });
      assert.deepEqual(asked, {
        mock_alt: ['mock_alt_out_1'],
        bachs: ['bachs_ref_1'],
        mock: [],
      });
      const payout = async (id) =>
        (
          await q('SELECT status, provider FROM payouts WHERE id = $1', [id])
        )[0];
      // Each recorded under its own name: never re-labelled as another provider's.
      assert.deepEqual(await payout(alt.payoutId), {
        status: 'PAID',
        provider: 'mock_alt',
      });
      assert.deepEqual(await payout(bachs.payoutId), {
        status: 'PAID',
        provider: 'bachs',
      });
      assert.deepEqual(await payout(unlisted.payoutId), {
        status: 'PROCESSING',
        provider: 'mock',
      });
      assert.deepEqual(
        (
          await q(
            `SELECT provider, provider_event_id FROM provider_events
              WHERE event_type = 'payout.paid' ORDER BY provider`,
          )
        ).map((r) => `${r.provider}:${r.provider_event_id}`),
        ['bachs:evt_bachs_ref_1', 'mock_alt:evt_mock_alt_out_1'],
      );
      // The unlisted provider's row is left alone: not even stamped as checked.
      assert.deepEqual(
        (await q('SELECT unmatched_id FROM parked_payout_checks ORDER BY 1'))
          .map((r) => r.unmatched_id)
          .sort(),
        [alt.unmatchedId, bachs.unmatchedId].sort(),
      );
    },
  );

  await t.test(
    'a parked event never adopts a payout at another provider',
    async () => {
      await database.fresh();
      // A mock_alt event whose signed reference names a payout that is Bachs's, on the same
      // account reference: never adopted or read through either provider.
      const payoutId = randomUUID();
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                              request_fingerprint, provider, account_reference, start_uncertain_at)
         VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'f', 'bachs', 'acct_1', now())`,
        [payoutId, ADA, randomUUID()],
      );
      await q(
        `INSERT INTO unmatched_provider_events
           (id, provider, provider_event_id, event_type, payload_hash, payload, reason)
         VALUES ($1, 'mock_alt', 'evt_cross', 'payout.paid', 'h', $2, 'unknown_payout')`,
        [
          randomUUID(),
          JSON.stringify({
            providerReference: 'mock_alt_out_x',
            accountReference: 'acct_1',
            status: 'paid',
            operationReference: payoutId,
          }),
        ],
      );
      const asked = [];
      await reconcilePayouts({
        db: database.db,
        provider: (name) => ({
          fetchPayoutStatus: async (reference) => {
            asked.push(`${name}:${reference}`);
            return { status: 'paid' };
          },
          findPayoutByReference: async () => null,
        }),
        parkedProviders: ['mock_alt'],
        now: new Date(),
        minAgeMs: 3_600_000,
      });
      assert.deepEqual(asked, []);
      assert.deepEqual(
        (
          await q(
            'SELECT status, provider, provider_reference FROM payouts WHERE id = $1',
            [payoutId],
          )
        )[0],
        { status: 'REQUESTED', provider: 'bachs', provider_reference: null },
      );
    },
  );
  await t.test(
    'parked Bachs events reach staff on a copy with no Bachs adapter',
    async () => {
      await database.fresh();
      // A copy back on mock with no Bachs keys: every Bachs read fails. The read-free checks still
      // run, so a parked row never sits unseen (issues.ts leaves parked Bachs rows to this sweep).
      await q(
        `INSERT INTO payment_accounts
           (id, profile_id, provider, environment, provider_account_reference, status,
            charges_enabled, payouts_enabled, fee_collector)
         VALUES ($1, $2, 'bachs', 'sandbox', 'acct_gone', 'ACTIVE', true, true, 'platform')`,
        [randomUUID(), ADA],
      );
      const named = randomUUID();
      await q(
        `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key,
                              request_fingerprint, provider, account_reference, start_uncertain_at)
         VALUES ($1, $2, 'NGN', 100000, 'REQUESTED', $3, 'f', 'bachs', 'acct_gone', now())`,
        [named, ADA, randomUUID()],
      );
      const park = (eventId, payload) =>
        q(
          `INSERT INTO unmatched_provider_events
             (id, provider, provider_event_id, event_type, payload_hash, payload, reason)
           VALUES ($1, 'bachs', $2, 'payout.paid', 'h', $3, 'unknown_payout')`,
          [randomUUID(), eventId, JSON.stringify(payload)],
        );
      // Nobody asked for this one.
      await park('evt_stranger', {
        providerReference: 'bachs_ref_stranger',
        accountReference: 'acct_gone',
        status: 'paid',
      });
      // This one names our payout: it needs a read, which cannot happen here.
      await park('evt_ours', {
        providerReference: 'bachs_ref_ours',
        accountReference: 'acct_gone',
        status: 'paid',
        operationReference: named,
      });
      const result = await reconcilePayouts({
        db: database.db,
        provider: (name) => {
          throw new Error(`Unsupported persisted payment provider (${name})`);
        },
        parkedProviders: ['bachs'],
        now: later(3 * 24 * 60),
        minAgeMs: 30 * 24 * 3_600_000,
      });
      assert.ok(result.errors >= 1, 'the missing reader counts as an error');
      const kinds = (
        await q(`SELECT kind, dedupe_key FROM issues ORDER BY kind`)
      ).map((i) => `${i.kind}:${i.dedupe_key.split('.')[0]}`);
      assert.ok(kinds.includes('payout_unexpected:payout_unexpected'), kinds);
      assert.ok(kinds.includes('payout_unresolved:payout_parked'), kinds);
    },
  );
});
