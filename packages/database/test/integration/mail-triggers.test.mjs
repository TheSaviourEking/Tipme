import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  beginPaymentAccountCreation,
  createPaymentIntent,
  createQuote,
  recordProviderEvent,
  deleteAccount,
  evaluateTipMoments,
  grantOwner,
  mailForDomainEvent,
  mailSealing,
  setPageSuspension,
  updatePaymentAccountStatus,
} from '../../dist/index.js';
import { queuedMail } from '../../dist/test-support.js';
import { ADA, useDatabase } from './helpers.mjs';

const sealing = mailSealing(Buffer.alloc(32, 7));
const OWNER_EMAIL = 'owner@example.com';
const STAFF = '00000000-0000-7000-8000-000000007c11';

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const [{ user_id: userId }] = await rows(
    'SELECT user_id FROM profiles WHERE id = $1',
    [ADA],
  );
  await rows(
    'UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2',
    [OWNER_EMAIL, userId],
  );
  const sent = async (type) =>
    (await queuedMail(database.db, sealing, { limit: 100 })).filter(
      (m) => m.type === type,
    );
  return { ...database, rows, sent, userId };
}

/** A tip a verified provider event has settled, as the payouts tests make one. */
async function paidTip(db, handle) {
  const { quoteId } = await createQuote(db, {
    handle,
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  await recordProviderEvent(db, {
    provider: 'mock',
    providerEventId: randomUUID(),
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: `pay-${intent.attemptId}`,
    amountMinor: 100000n,
    currency: 'NGN',
    providerFeeMinor: 1500n,
    signatureVerified: true,
    payload: {},
  });
  return intent;
}

const account = (status, extra = {}) => ({
  profileId: ADA,
  provider: 'bachs',
  environment: 'sandbox',
  providerAccountReference: 'acct_ada123',
  status,
  chargesEnabled: status === 'ACTIVE',
  payoutsEnabled: false,
  feeCollector: 'platform',
  requirementsDue: [],
  sealing,
  ...extra,
});

async function paymentAccount(db) {
  await beginPaymentAccountCreation(db, {
    profileId: ADA,
    provider: 'bachs',
    environment: 'sandbox',
  });
}

test('payment_account_ready is queued once when the account becomes ready', async (t) => {
  const { db, sent } = await fresh(t);
  await paymentAccount(db);
  await updatePaymentAccountStatus(db, account('ONBOARDING'));
  assert.equal((await sent('payment_account_ready')).length, 0);
  await updatePaymentAccountStatus(db, account('ACTIVE'));
  await updatePaymentAccountStatus(db, account('ACTIVE'));
  const mails = await sent('payment_account_ready');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, OWNER_EMAIL);
});

test('payment_account_action_needed: a restriction, or a ready account needing more, not setup', async (t) => {
  const { db, sent } = await fresh(t);
  await paymentAccount(db);
  await updatePaymentAccountStatus(
    db,
    account('ONBOARDING', { requirementsDue: ['identity'] }),
  );
  assert.equal(
    (await sent('payment_account_action_needed')).length,
    0,
    'setting up always needs information: no alarm',
  );
  await updatePaymentAccountStatus(db, account('ACTIVE'));
  await updatePaymentAccountStatus(db, account('RESTRICTED'));
  await updatePaymentAccountStatus(db, account('RESTRICTED'));
  assert.equal((await sent('payment_account_action_needed')).length, 1);
});

test('no payment account email when the update is refused', async (t) => {
  const { db, sent } = await fresh(t);
  await paymentAccount(db);
  await updatePaymentAccountStatus(db, account('ONBOARDING'));
  await assert.rejects(
    updatePaymentAccountStatus(
      db,
      account('ACTIVE', { providerAccountReference: 'acct_other' }),
    ),
  );
  assert.equal((await sent('payment_account_ready')).length, 0);
});

test('page_paused and page_restored are queued once per action, with no staff reason', async (t) => {
  const { db, sent } = await fresh(t);
  const reason = 'internal note about this person';
  const act = (suspend) =>
    setPageSuspension(db, {
      profileId: ADA,
      staffUserId: STAFF,
      suspend,
      reason,
      sealing,
    });
  await act(true);
  await act(false);
  const [paused] = await sent('page_paused');
  assert.ok(paused);
  assert.equal((await sent('page_restored')).length, 1);
  assert.ok(!JSON.stringify(paused.data).includes(reason));
});

test('no page email when the page doesn’t exist', async (t) => {
  const { db, sent } = await fresh(t);
  await assert.rejects(
    setPageSuspension(db, {
      profileId: '00000000-0000-7000-8000-00000000dead',
      staffUserId: STAFF,
      suspend: true,
      reason: 'a reason here',
      sealing,
    }),
  );
  assert.equal((await sent('page_paused')).length, 0);
});

test('account_deleted_notice goes to the address the account had, once', async (t) => {
  const { db, sent, rows, userId } = await fresh(t);
  await rows("UPDATE tips SET status = 'FAILED' WHERE profile_id = $1", [ADA]);
  await deleteAccount(db, { userId, sealing });
  const mails = await sent('account_deleted_notice');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, OWNER_EMAIL);
});

test('no account_deleted_notice when a tip still confirming stops the deletion', async (t) => {
  const { db, sent, pool, userId } = await fresh(t);
  const intent = await createPaymentIntent(db, {
    quoteId: (
      await createQuote(db, {
        handle: 'ada',
        tipMinor: 100000n,
        currency: 'NGN',
      })
    ).quoteId,
    idempotencyKey: randomUUID(),
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      "UPDATE payment_attempts SET status = 'PENDING' WHERE id = $1",
      [intent.attemptId],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await assert.rejects(deleteAccount(db, { userId, sealing }));
  assert.equal((await sent('account_deleted_notice')).length, 0);
});

test('staff_access_notice is queued when access is granted', async (t) => {
  const { db, sent } = await fresh(t);
  await grantOwner(db, { email: OWNER_EMAIL, sealing });
  const mails = await sent('staff_access_notice');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].data.change, 'granted');
});

test('withdrawal_paid and withdrawal_failed are queued once per payout', async (t) => {
  const { db, sent, rows } = await fresh(t);
  const payout = async (id, status) =>
    rows(
      `INSERT INTO payouts (id, profile_id, amount_minor, currency, status, idempotency_key, request_fingerprint)
       VALUES ($1, $2, 250000, 'NGN', $3, $4, $4)`,
      [id, ADA, status, randomUUID()],
    );
  const paid = '00000000-0000-7000-8000-00000000a001';
  const failed = '00000000-0000-7000-8000-00000000a002';
  await payout(paid, 'PAID');
  await payout(failed, 'FAILED');
  for (let i = 0; i < 2; i += 1) {
    await mailForDomainEvent(db, sealing, 'payout.paid', {
      payoutId: paid,
      profileId: ADA,
    });
    await mailForDomainEvent(db, sealing, 'payout.failed', {
      payoutId: failed,
      profileId: ADA,
    });
  }
  const [mail] = await sent('withdrawal_paid');
  assert.equal((await sent('withdrawal_paid')).length, 1);
  assert.equal(mail.data.amountMinor, '250000');
  assert.equal((await sent('withdrawal_failed')).length, 1);
});

test('events the mail doesn’t know, or bad payloads, queue nothing', async (t) => {
  const { db, rows } = await fresh(t);
  await mailForDomainEvent(db, sealing, 'payout.conflict', { payoutId: 'x' });
  await mailForDomainEvent(db, sealing, 'payout.paid', { payoutId: 'x' });
  await mailForDomainEvent(db, sealing, 'payment.reversed', null);
  assert.equal((await rows('SELECT id FROM mail_messages')).length, 0);
});

test('milestone is queued once when a milestone moment is created', async (t) => {
  const { db, sent, rows } = await fresh(t);
  await paidTip(db, 'ada');
  const [tip] = await rows(
    `SELECT id FROM tips WHERE profile_id = $1 AND status = 'SUCCEEDED' LIMIT 1`,
    [ADA],
  );
  const input = {
    profileId: ADA,
    tipId: tip.id,
    now: new Date(),
    budgetPerMonthMinor: 0n,
    sealing,
  };
  const { created } = await evaluateTipMoments(db, input);
  await evaluateTipMoments(db, input);
  const milestones = created.filter((key) => key.startsWith('milestone.'));
  assert.ok(milestones.length > 0, 'the first tip is a milestone');
  assert.equal((await sent('milestone')).length, milestones.length);
});

test('tip_reversed is queued once per provider event', async (t) => {
  const { db, sent } = await fresh(t);
  const { attemptId } = await paidTip(db, 'ada');
  const event = (key) =>
    mailForDomainEvent(db, sealing, 'payment.reversed', { attemptId }, key);
  await event('payment.reversed.a');
  await event('payment.reversed.a');
  assert.equal((await sent('tip_reversed')).length, 1);
  await event('payment.reversed.b');
  assert.equal((await sent('tip_reversed')).length, 2);
});

test('fix: restoring a page that was never paused sends nothing', async (t) => {
  const { db, sent } = await fresh(t);
  const act = (suspend) =>
    setPageSuspension(db, {
      profileId: ADA,
      staffUserId: STAFF,
      suspend,
      reason: 'checking the button',
      sealing,
    });
  await act(false);
  assert.equal((await sent('page_restored')).length, 0);
  await act(true);
  await act(true);
  assert.equal(
    (await sent('page_paused')).length,
    1,
    'a repeat changes nothing',
  );
});
