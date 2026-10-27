import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  beginPaymentAccountCreation,
  claimAttemptStart,
  createPaymentIntent,
  createQuote,
  expireStaleAttemptStarts,
  expireStalePaymentAccountCreations,
  findAttemptStart,
  findBachsAttemptByOperationReference,
  getPaymentAccountForProfile,
  markAttemptInitiated,
  markAttemptUnknown,
  markPaymentAccountCreationFailed,
  markPaymentAccountCreationUnknown,
  reconcileAttempts,
  recordProviderEvent,
  updatePaymentAccountStatus,
} from '../../dist/index.js';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

async function createAttempt(db, handle = 'ada') {
  const { quoteId } = await createQuote(db, {
    handle,
    tipMinor: 100000n,
    currency: 'NGN',
  });
  return createPaymentIntent(db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
}

test('attempt start is claimed once and stale external writes stay UNKNOWN', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { attemptId } = await createAttempt(database.db);
  const claimDate = new Date('2026-10-26T12:00:00.000Z');
  const claims = await Promise.all([
    claimAttemptStart(database.db, {
      attemptId,
      provider: 'bachs',
      now: claimDate,
    }),
    claimAttemptStart(database.db, {
      attemptId,
      provider: 'bachs',
      now: claimDate,
    }),
  ]);
  assert.equal(
    claims.filter((result) => result.outcome === 'claimed').length,
    1,
  );
  assert.equal(
    claims.filter((result) => result.outcome === 'existing').length,
    1,
  );

  assert.equal(
    await expireStaleAttemptStarts(database.db, {
      olderThan: new Date(claimDate.getTime() + 1),
      now: new Date(claimDate.getTime() + 2),
    }),
    1,
  );
  assert.equal(
    (await findAttemptStart(database.db, attemptId))?.status,
    'UNKNOWN',
  );
  assert.equal(
    (
      await claimAttemptStart(database.db, {
        attemptId,
        provider: 'bachs',
      })
    ).outcome,
    'existing',
  );
  assert.equal(
    await markAttemptUnknown(database.db, {
      attemptId,
      provider: 'bachs',
    }),
    'already_unknown',
  );
});

test('recipient account creation is unique, ambiguous creation is not retryable, and webhook mapping is scoped', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const claimDate = new Date('2026-10-26T12:00:00.000Z');
  const claims = await Promise.all([
    beginPaymentAccountCreation(database.db, {
      profileId: ADA,
      provider: 'bachs',
      environment: 'sandbox',
      now: claimDate,
    }),
    beginPaymentAccountCreation(database.db, {
      profileId: ADA,
      provider: 'bachs',
      environment: 'sandbox',
      now: claimDate,
    }),
  ]);
  assert.equal(claims.filter((result) => result.created).length, 1);
  assert.equal(claims.filter((result) => !result.created).length, 1);

  assert.equal(
    await expireStalePaymentAccountCreations(database.db, {
      olderThan: new Date(claimDate.getTime() + 1),
      now: new Date(claimDate.getTime() + 2),
    }),
    1,
  );
  assert.equal(
    await markPaymentAccountCreationUnknown(database.db, {
      profileId: ADA,
      provider: 'bachs',
      environment: 'sandbox',
    }),
    false,
  );
  const held = await beginPaymentAccountCreation(database.db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
  });
  assert.equal(held.created, false);
  assert.equal(held.account.status, 'UNKNOWN');

  assert.equal(
    await markPaymentAccountCreationFailed(database.db, {
      profileId: ADA,
      provider: 'bachs',
      environment: 'sandbox',
    }),
    false,
  );

  await beginPaymentAccountCreation(database.db, {
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
  });
  assert.equal(
    await markPaymentAccountCreationFailed(database.db, {
      profileId: TOBI,
      provider: 'bachs',
      environment: 'sandbox',
    }),
    true,
  );
  assert.equal(
    (
      await beginPaymentAccountCreation(database.db, {
        profileId: TOBI,
        provider: 'bachs',
        environment: 'sandbox',
      })
    ).created,
    true,
  );
  await updatePaymentAccountStatus(database.db, {
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_123abc',
    status: 'ACTIVE',
    chargesEnabled: true,
    payoutsEnabled: false,
    feeCollector: 'platform',
    requirementsDue: [],
  });

  const { attemptId } = await createAttempt(database.db, 'tobi');
  await claimAttemptStart(database.db, { attemptId, provider: 'bachs' });
  await markAttemptUnknown(database.db, {
    attemptId,
    provider: 'bachs',
  });
  assert.equal(
    await findBachsAttemptByOperationReference(database.db, {
      attemptId,
      accountReference: 'acct_wrong456',
    }),
    null,
  );
  assert.equal(
    await findBachsAttemptByOperationReference(database.db, {
      attemptId,
      accountReference: 'acct_123abc',
    }),
    attemptId,
  );
  const pending = await recordProviderEvent(database.db, {
    provider: 'bachs',
    providerEventId: randomUUID(),
    eventType: 'payment.pending',
    attemptId,
    providerReference: 'acct_123abc:chk_456def',
    amountMinor: 100000n,
    currency: 'NGN',
    providerFeeMinor: 0n,
    signatureVerified: true,
    payload: { type: 'checkout.completed' },
  });
  assert.equal(pending.outcome, 'applied');
  assert.equal(pending.attemptStatus, 'PENDING');
  assert.deepEqual(await findAttemptStart(database.db, attemptId), {
    status: 'PENDING',
    provider: 'bachs',
    reference: 'acct_123abc:chk_456def',
  });
  assert.equal(
    await getPaymentAccountForProfile(database.db, {
      profileId: TOBI,
      provider: 'bachs',
      environment: 'sandbox',
    }).then((account) => account?.status),
    'ACTIVE',
  );
  const safeAccount = await getPaymentAccountForProfile(database.db, {
    profileId: TOBI,
    provider: 'bachs',
    environment: 'sandbox',
  });
  assert.equal(Object.hasOwn(safeAccount, 'providerAccountReference'), false);
});

test('reconciliation resolves each attempt through its persisted provider', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const bachs = await createAttempt(database.db, 'ada');
  const mock = await createAttempt(database.db, 'tobi');
  await markAttemptInitiated(database.db, {
    attemptId: bachs.attemptId,
    provider: 'bachs',
    providerReference: 'acct_123abc:chk_123abc',
  });
  await markAttemptInitiated(database.db, {
    attemptId: mock.attemptId,
    provider: 'mock',
    providerReference: 'mock_pay_123abc',
  });

  const providers = ['bachs', 'mock'];
  const called = [];
  const result = await reconcileAttempts({
    db: database.db,
    provider: (name) => {
      called.push(name);
      assert.ok(providers.includes(name));
      return {
        async verifyTransaction() {
          return {
            status: 'pending',
            amountMinor: 100000n,
            currency: 'NGN',
            feeMinor: 0n,
          };
        },
      };
    },
    now: new Date(Date.now() + 1000),
    minAgeMs: 0,
  });

  assert.equal(result.checked, 2);
  assert.equal(result.errors, 0);
  assert.deepEqual(called.sort(), providers);
});
