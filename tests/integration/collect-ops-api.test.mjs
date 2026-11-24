import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import {
  openTestDatabase,
  queuedMail,
} from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import {
  MAIL_SEAL_KEY,
  OPS_TOTP_KEY,
  WEB,
  browserHeaders,
  opsSignIn,
  setSwitch,
  startStack,
} from './helpers.mjs';

/*
 * You collect staff screens (plan Task 15, spec §9). Reading is `collect.view`, masked as today
 * (handles, amounts, a bank's last four digits; no partner account, no full account number, nothing
 * about a supporter). Every money action is a serious action on `collect.manage`: a second person
 * when one qualifies, refused when the money has moved on, and done once. The items carried from
 * Tasks 5, 10 and 13 are here too: releasing a closed dispute's hold (P28), recording a transfer in
 * review as paid (P24–P27, only on the partner's read-back), clearing a shared bank account hold
 * (and the notice it held back), support's name change (checked by the partner again), booking a
 * refund the partner paid unexpectedly (RI3), and the evidence state from TipMe's own records.
 */

const [ADA, TOBI] = ops.DEMO_PROFILES;
const GROSS = 1_000_000n;
const NET = 950_000n;
const DAY = 86_400_000;
const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON = 'Checked in the partner dashboard today';

let database;
let stack;
/** What the partner's transfer list shows, per account (the read-back's stand-in). */
const listed = new Map();
const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
  collectReader: () => ({
    listAccountTransfers: async (ref) => listed.get(ref) ?? [],
  }),
});

const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  ops.registerRealSeriousActions();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: { WEB_ORIGIN: WEB, RATE_LIMIT_AUTH_PER_HOUR: '1000' },
  });
});
after(async () => {
  await setSwitch(database.pool, 'you_collect', false);
  await stack?.stop();
  await database.close();
});
beforeEach(async () => {
  listed.clear();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  await setSwitch(database.pool, 'you_collect', true);
  await q(`UPDATE profiles SET created_at = now() - interval '60 days'`);
});

/* People */

const people = new Map();
async function person({ roleId = 'owner' } = {}) {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`co.${randomUUID().slice(0, 8)}@example.com`],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())`,
    [id, roleId],
  );
  const secret = newTotpSecret();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [id, ops.sealSecret(key, secret)],
  );
  const [{ id: sessionId }] = await q(
    `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day') RETURNING id`,
    [id, randomBytes(32).toString('hex')],
  );
  const [{ id: grantId }] = await q(
    `INSERT INTO ops_sessions (id, user_id, session_id, token_sha256, created_at, last_seen_at, expires_at, last_totp_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now(), now() + interval '1 hour', now()) RETURNING id`,
    [id, sessionId, randomBytes(32).toString('hex')],
  );
  people.set(id, { secret, grantId });
  return id;
}

const ask = (actorId, name, payload) =>
  ops.requestSeriousAction(database.db, {
    name,
    payload,
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    services: services(),
  });
const approve = (requestId, actorId) =>
  ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: totpAt(
      people.get(actorId).secret,
      BigInt(Math.floor(Date.now() / 30_000)),
    ),
    key,
    services: services(),
  });
const refusedWith = (code) => (error) =>
  error instanceof ops.OperationError && error.code === code;

/* Money fixtures */

/** A paid collect tip to `profile`: held money and one waiting share (Task 7). */
async function paidTip(profile) {
  const { db } = database;
  await q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    profile.id,
  ]);
  const quote = await ops.createQuote(db, {
    handle: profile.handle,
    tipMinor: GROSS,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: `platform:cs_${randomUUID().slice(0, 8)}`,
  });
  await q(
    `UPDATE payment_attempts SET created_at = now() - interval '1 minute' WHERE id = $1`,
    [intent.attemptId],
  );
  const result = await ops.reconcileAttempts({
    db,
    provider: {
      environment: 'sandbox',
      async verifyTransaction() {
        return {
          status: 'succeeded',
          amountMinor: GROSS,
          currency: 'NGN',
          feeMinor: 20_000n,
          feePaidBy: 'platform',
          method: 'NGN_CARD',
          chargeReference: `ch_${randomUUID().slice(0, 8)}`,
        };
      },
    },
    now: new Date(),
    minAgeMs: 0,
    attemptId: intent.attemptId,
  });
  assert.equal(result.applied, 1);
  const [row] = await q(
    `SELECT id, idempotency_key FROM collect_transfers WHERE tip_id = $1 AND kind = 'share'`,
    [intent.tipId],
  );
  return { tipId: intent.tipId, rowId: row.id, group: row.idempotency_key };
}

const NAME = { first: 'Ada', last: 'Okafor' };
/** A verified recipient with a usable bank (Task 13's outcome), its partner account `acct_<handle>`. */
async function verified(profile, name = NAME) {
  await q(
    `UPDATE profiles SET collection_mode = 'collect', collect_verified_at = now() - interval '1 day',
            collect_legal_name = $2 WHERE id = $1`,
    [profile.id, JSON.stringify(name)],
  );
  await q(
    `INSERT INTO payment_accounts (id, profile_id, provider, environment, provider_account_reference, status)
     VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ONBOARDING') ON CONFLICT DO NOTHING`,
    [randomUUID(), profile.id, `acct_${profile.handle}`],
  );
  await q(
    `INSERT INTO payout_destinations (id, profile_id, provider, destination_reference, bank_code, bank_name,
                                      account_last4, status, name_digest)
     VALUES ($1, $2, 'bachs', $3, '058', 'Pretend Guaranty Bank', '1234', 'usable', $4)`,
    [
      randomUUID(),
      profile.id,
      `dest_${profile.handle}`,
      ops.legalNameDigest(name),
    ],
  );
}

async function dispute(tipId, edits = {}) {
  const id = randomUUID();
  const row = {
    status: 'open',
    respondBy: new Date(Date.now() + 5 * DAY),
    shareStep: null,
    provider: 'mock',
    decidedAt: null,
    ...edits,
  };
  await q(
    `INSERT INTO disputes (id, provider, partner_dispute_id, tip_id, amount_minor, currency, status, respond_by,
                           share_step, decided_at, last_event_at)
     VALUES ($1, $2, $3, $4, $5, 'NGN', $6, $7, $8, $9, now())`,
    [
      id,
      row.provider,
      `dsp_${id.slice(0, 8)}`,
      tipId,
      NET,
      row.status,
      row.respondBy,
      row.shareStep,
      row.decidedAt,
    ],
  );
  return id;
}

const ledgerHeld = async () =>
  (
    await q(`SELECT COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS held
               FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
              WHERE a.code = 'held_for_recipients'`)
  )[0].held;
const unbalanced = () =>
  q(`SELECT t.id FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
      GROUP BY t.id HAVING SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END) <> 0`);
const entries = async () =>
  Number((await q(`SELECT count(*)::int AS n FROM ledger_entries`))[0].n);

/* API */

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
let phoneSeq = 0;
async function staffWith(permissions) {
  phoneSeq += 1;
  const phone = `+23480377${String(Date.now()).slice(-3)}${String(phoneSeq).padStart(2, '0')}`;
  const session = await opsSignIn(stack.api, database.db, phone);
  if (permissions) {
    const roleId = `role_${randomUUID().slice(0, 8)}`;
    await q(`INSERT INTO roles (id, name) VALUES ($1, $1)`, [roleId]);
    for (const permission of permissions)
      await q(
        `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`,
        [roleId, permission],
      );
    await q(
      `UPDATE staff SET role_id = $2 WHERE user_id = (SELECT id FROM users WHERE phone_e164 = $1)`,
      [phone, roleId],
    );
  }
  return session.cookie;
}

const READS = [
  '/v1/ops/collect/held',
  '/v1/ops/collect/transfers',
  '/v1/ops/collect/transfers?status=review',
  '/v1/ops/collect/disputes',
  '/v1/ops/collect/same-bank',
  '/v1/ops/collect/unclaimed',
];

test('staff without collect.view get 403; masking hides account numbers and supporter details', async () => {
  await verified(ADA);
  const { tipId } = await paidTip(ADA);
  await q(
    `UPDATE collect_transfers SET account_reference = 'acct_ada', status = 'ready' WHERE tip_id = $1`,
    [tipId],
  );
  const disputeId = await dispute(tipId);
  const outsider = await staffWith(['search.view']);
  for (const path of [...READS, `/v1/ops/collect/disputes/${disputeId}`])
    assert.equal((await call('GET', path, outsider)).status, 403, path);
  // collect.view reads, but can't act: every action is collect.manage.
  const viewer = await staffWith(['collect.view']);
  const texts = [];
  for (const path of [...READS, `/v1/ops/collect/disputes/${disputeId}`]) {
    const response = await call('GET', path, viewer);
    assert.equal(response.status, 200, path);
    texts.push(await response.text());
  }
  const all = texts.join('\n');
  for (const secret of [
    'acct_ada', // the partner account
    'accountReference',
    'account_reference',
    'dest_', // the partner's destination id
    'email',
    'supporter',
    'chargeReference',
    'ch_',
  ])
    assert.ok(!all.includes(secret), `${secret} leaked`);
  const transfers = JSON.parse(texts[1]).data;
  const mine = transfers.find((t) => t.handle === ADA.handle);
  assert.equal(mine.bankLast4, '1234');
  assert.equal(mine.group, `tipme-collect-${tipId}`);
  assert.equal(
    (
      await call('POST', `/v1/ops/collect/transfers/${mine.id}/retry`, viewer, {
        reason: REASON,
      })
    ).status,
    403,
  );
});

test('held money totals match the ledger', async () => {
  await paidTip(ADA);
  await paidTip(ADA);
  await paidTip(TOBI);
  const cookie = await staffWith(null);
  const held = (
    await (await call('GET', '/v1/ops/collect/held', cookie)).json()
  ).data;
  const total = held.totals.find((t) => t.currency === 'NGN');
  assert.equal(total.heldMinor, await ledgerHeld());
  assert.equal(total.heldMinor, String(3n * NET));
  const ada = held.recipients.find((r) => r.handle === ADA.handle);
  const tobi = held.recipients.find((r) => r.handle === TOBI.handle);
  assert.equal(ada.heldMinor, String(2n * NET));
  assert.equal(tobi.heldMinor, String(NET));
  const sum = held.recipients.reduce((s, r) => s + BigInt(r.heldMinor), 0n);
  assert.equal(String(sum), total.heldMinor);
  // Not verified: kept for them, the holding cap's days counting down, no reminders yet.
  assert.equal(ada.verified, false);
  assert.ok(ada.oldestTipAt);
  assert.equal(ada.daysLeft, 30);
  assert.equal(ada.remindersSent, 0);
  assert.equal(ada.paused, false);
});

test('recipients past the holding cap are listed as unclaimed, and nothing happens to them', async () => {
  const { tipId } = await paidTip(ADA);
  await paidTip(TOBI);
  // Ada's first tip settled 31 days ago: the cap's 30 days are over.
  await q(
    `UPDATE tips SET completed_at = now() - interval '31 days' WHERE id = $1`,
    [tipId],
  );
  const cookie = await staffWith(null);
  const rows = (
    await (await call('GET', '/v1/ops/collect/unclaimed', cookie)).json()
  ).data;
  assert.deepEqual(
    rows.map((r) => [r.handle, r.pausedReason, r.heldMinor]),
    [[ADA.handle, 'days', String(NET)]],
  );
  const [{ status }] = await q(
    `SELECT status FROM collect_transfers WHERE tip_id = $1`,
    [tipId],
  );
  assert.equal(status, 'waiting');
});

test('retry is allowed only from review and needs a second person', async () => {
  await verified(ADA);
  const { rowId } = await paidTip(ADA);
  const first = await person();
  // Waiting: not in review, so nothing to retry; asking is refused and nothing is recorded.
  await assert.rejects(
    ask(first, 'collect_transfer.retry', { transferId: rowId }),
    refusedWith('COLLECT_ACTION_REFUSED'),
  );
  // A dispute's hold is released by its own flow, never by a retry.
  await q(
    `UPDATE collect_transfers SET status = 'review', review_reason = 'dispute' WHERE id = $1`,
    [rowId],
  );
  await assert.rejects(
    ask(first, 'collect_transfer.retry', { transferId: rowId }),
    refusedWith('COLLECT_ACTION_REFUSED'),
  );
  await q(
    `UPDATE collect_transfers SET review_reason = 'provider', account_reference = 'acct_ada' WHERE id = $1`,
    [rowId],
  );
  const second = await person();
  const outcome = await ask(first, 'collect_transfer.retry', {
    transferId: rowId,
  });
  assert.equal(outcome.state, 'pending');
  const status = async () =>
    (await q(`SELECT status FROM collect_transfers WHERE id = $1`, [rowId]))[0]
      .status;
  assert.equal(await status(), 'review');
  assert.equal((await approve(outcome.requestId, second)).status, 'approved');
  assert.equal(await status(), 'ready');
});

test('a retry approved after the row moved on is refused and changes nothing', async () => {
  const { rowId } = await paidTip(ADA);
  await q(
    `UPDATE collect_transfers SET status = 'review', review_reason = 'staff' WHERE id = $1`,
    [rowId],
  );
  const first = await person();
  const second = await person();
  const outcome = await ask(first, 'collect_transfer.retry', {
    transferId: rowId,
  });
  await q(
    `UPDATE collect_transfers SET status = 'waiting', review_reason = NULL WHERE id = $1`,
    [rowId],
  );
  const approved = await approve(outcome.requestId, second);
  assert.notEqual(approved.status, 'approved');
});

test('send to review holds only a transfer never sent, one person with a reason, audited', async () => {
  const { rowId } = await paidTip(ADA);
  const cookie = await staffWith(null);
  const response = await call(
    'POST',
    `/v1/ops/collect/transfers/${rowId}/review`,
    cookie,
    { reason: REASON },
  );
  assert.equal(response.status, 200);
  const [row] = await q(
    `SELECT status, review_reason FROM collect_transfers WHERE id = $1`,
    [rowId],
  );
  assert.deepEqual(row, { status: 'review', review_reason: 'staff' });
  assert.equal(
    (
      await q(
        `SELECT 1 FROM audit_events WHERE action = 'collect_transfer.held' AND subject_id = $1`,
        [rowId],
      )
    ).length,
    1,
  );
  // Already in review (or sent): refused.
  assert.equal(
    (
      await call('POST', `/v1/ops/collect/transfers/${rowId}/review`, cookie, {
        reason: REASON,
      })
    ).status,
    409,
  );
});

test('recording a transfer in review as paid is refused unless the partner read-back confirms it, and books once', async () => {
  const { rowId, group } = await paidTip(ADA);
  await q(
    `UPDATE collect_transfers SET status = 'review', review_reason = 'provider', sent_at = now(),
            account_reference = 'acct_ada', attempts = 1 WHERE id = $1`,
    [rowId],
  );
  const lone = await person();
  const before = await ledgerHeld();
  // Nothing at the partner, another amount, or two in the group: never recorded.
  for (const list of [
    [],
    [
      {
        transferRef: 'tr_1',
        status: 'paid',
        amountMinor: NET + 1n,
        currency: 'NGN',
        group,
      },
    ],
    [
      {
        transferRef: 'tr_1',
        status: 'pending',
        amountMinor: NET,
        currency: 'NGN',
        group,
      },
    ],
    [
      {
        transferRef: 'tr_1',
        status: 'paid',
        amountMinor: NET,
        currency: 'NGN',
        group,
      },
      {
        transferRef: 'tr_2',
        status: 'paid',
        amountMinor: NET,
        currency: 'NGN',
        group,
      },
    ],
    [
      {
        transferRef: 'tr_1',
        status: 'paid',
        amountMinor: NET,
        currency: 'NGN',
        group: null,
      },
    ],
  ]) {
    listed.set('acct_ada', list);
    await assert.rejects(
      ask(lone, 'collect_transfer.record_paid', { transferId: rowId }),
      refusedWith('COLLECT_READ_BACK_UNCONFIRMED'),
    );
  }
  assert.equal(await ledgerHeld(), before);
  listed.set('acct_ada', [
    {
      transferRef: 'tr_ok',
      status: 'paid',
      amountMinor: NET,
      currency: 'NGN',
      group,
    },
  ]);
  const outcome = await ask(lone, 'collect_transfer.record_paid', {
    transferId: rowId,
  });
  assert.equal(outcome.state, 'ran');
  const [row] = await q(
    `SELECT status, transfer_reference FROM collect_transfers WHERE id = $1`,
    [rowId],
  );
  assert.deepEqual(row, { status: 'paid', transfer_reference: 'tr_ok' });
  // The same booking as a normal paid transfer, once.
  assert.equal(
    (
      await q(
        `SELECT 1 FROM ledger_transactions WHERE operation_key = $1 AND operation_type = 'collect_transfer'`,
        [`collect_transfer.${rowId}`],
      )
    ).length,
    1,
  );
  assert.equal(await ledgerHeld(), String(BigInt(before) - NET));
  await assert.rejects(
    ask(lone, 'collect_transfer.record_paid', { transferId: rowId }),
    refusedWith('COLLECT_ACTION_REFUSED'),
  );
  assert.deepEqual(await unbalanced(), []);
});

test('a closed dispute’s hold is released early once, never while a refund is in flight, with the books unchanged', async () => {
  const { tipId, rowId } = await paidTip(ADA);
  await q(
    `UPDATE collect_transfers SET status = 'review', review_reason = 'refund' WHERE id = $1`,
    [rowId],
  );
  const disputeId = await dispute(tipId, {
    status: 'closed',
    shareStep: 'held',
    decidedAt: new Date(),
  });
  const lone = await person();
  const [{ id: userId }] = await q(
    `SELECT user_id AS id FROM profiles WHERE id = $1`,
    [ADA.id],
  );
  const [{ id: refundId }] = await q(
    `INSERT INTO tip_refunds (id, tip_id, status, amount_minor, currency, provider, provider_reference,
            requested_by, reason, collect_plan)
     VALUES (gen_random_uuid(), $1, 'REQUESTED', $2, 'NGN', 'bachs', 'platform:cs_x', $3,
             'The supporter asked for a refund', 'cancel_held') RETURNING id`,
    [tipId, NET, userId],
  );
  await assert.rejects(
    ask(lone, 'collect_dispute.release_hold', { disputeId }),
    refusedWith('COLLECT_ACTION_REFUSED'),
  );
  const cookie = await staffWith(['collect.view']);
  const detail = (
    await (
      await call('GET', `/v1/ops/collect/disputes/${disputeId}`, cookie)
    ).json()
  ).data;
  assert.equal(detail.holdRelease.possible, false);
  assert.match(detail.holdRelease.why, /refund/);
  await q(
    `UPDATE tip_refunds SET status = 'FAILED', failure = 'refused' WHERE id = $1`,
    [refundId],
  );
  const count = await entries();
  const outcome = await ask(lone, 'collect_dispute.release_hold', {
    disputeId,
  });
  assert.equal(outcome.state, 'ran');
  const [row] = await q(
    `SELECT settled_at IS NOT NULL AS settled, held_minor::text AS held FROM disputes WHERE id = $1`,
    [disputeId],
  );
  assert.deepEqual(row, { settled: true, held: '0' });
  const [share] = await q(
    `SELECT status, review_reason FROM collect_transfers WHERE id = $1`,
    [rowId],
  );
  assert.deepEqual(share, { status: 'waiting', review_reason: null });
  // The hold was a reservation, never a posting: nothing to book, and the books still balance.
  assert.equal(await entries(), count);
  assert.deepEqual(await unbalanced(), []);
  await assert.rejects(
    ask(lone, 'collect_dispute.release_hold', { disputeId }),
    refusedWith('COLLECT_ACTION_REFUSED'),
  );
});

test('an open or won dispute’s hold is not released from here', async () => {
  const { tipId } = await paidTip(ADA);
  const lone = await person();
  for (const status of ['open', 'won']) {
    const disputeId = await dispute(tipId, {
      status,
      shareStep: 'held',
      ...(status === 'won' ? { decidedAt: new Date() } : {}),
    });
    await assert.rejects(
      ask(lone, 'collect_dispute.release_hold', { disputeId }),
      refusedWith('COLLECT_ACTION_REFUSED'),
    );
    await q(`DELETE FROM disputes WHERE id = $1`, [disputeId]);
  }
});

const provider = {
  name: 'bachs-sandbox',
  payoutCapability: async () => ({ status: 'active' }),
  payoutDestinationStatus: async () => 'usable',
};

test('a shared bank account holds transfers and the "on their way" notice until staff clear it, once', async () => {
  const { rowId } = await paidTip(ADA);
  // Tobi already uses this bank account; Ada adds it second.
  const hash = 'h'.repeat(64);
  await q(
    `INSERT INTO payout_destinations (id, profile_id, provider, destination_reference, bank_code, bank_name,
                                      account_last4, status, account_hash)
     VALUES (gen_random_uuid(), $1, 'bachs', 'dest_tobi', '058', 'Pretend Guaranty Bank', '1234', 'usable', $2)`,
    [TOBI.id, hash],
  );
  await q(`UPDATE profiles SET collect_legal_name = $2 WHERE id = $1`, [
    ADA.id,
    JSON.stringify(NAME),
  ]);
  await q(
    `INSERT INTO payment_accounts (id, profile_id, provider, environment, provider_account_reference, status)
     VALUES (gen_random_uuid(), $1, 'bachs', 'sandbox', 'acct_ada', 'ONBOARDING')`,
    [ADA.id],
  );
  await q(
    `INSERT INTO payout_destinations (id, profile_id, provider, destination_reference, bank_code, bank_name,
                                      account_last4, status, account_hash, name_digest)
     VALUES (gen_random_uuid(), $1, 'bachs', 'dest_ada', '058', 'Pretend Guaranty Bank', '1234', 'usable', $2, $3)`,
    [ADA.id, hash, ops.legalNameDigest(NAME)],
  );
  const now = new Date();
  assert.equal(
    await ops.flagSharedBank(database.db, {
      profileId: ADA.id,
      accountHash: hash,
      now,
    }),
    true,
  );
  assert.equal(
    await ops.settleCollectVerification(database.db, {
      profileId: ADA.id,
      provider,
      accountReference: 'acct_ada',
      sealing,
      now,
    }),
    'verified',
  );
  const notices = () =>
    q(
      `SELECT n.id FROM notifications n JOIN profiles p ON p.user_id = n.user_id
        WHERE p.id = $1 AND n.kind = 'collect_verified'`,
      [ADA.id],
    );
  // Verified, but its transfers are held: "on their way" isn't true yet.
  assert.equal((await notices()).length, 0);
  const [held] = await q(
    `SELECT status, review_reason FROM collect_transfers WHERE id = $1`,
    [rowId],
  );
  assert.deepEqual(held, { status: 'review', review_reason: 'same_bank' });
  const cookie = await staffWith(null);
  const list = (
    await (await call('GET', '/v1/ops/collect/same-bank', cookie)).json()
  ).data;
  assert.deepEqual(
    list.map((r) => [r.handle, r.openIssues, r.heldTransfers]),
    [[ADA.handle, 1, 1]],
  );
  // Through the route, alone: done at once, and it says so.
  const response = await call(
    'POST',
    `/v1/ops/collect/same-bank/${ADA.id}/clear`,
    cookie,
    { reason: REASON },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.actedAlone, true);
  const [after] = await q(
    `SELECT status, review_reason FROM collect_transfers WHERE id = $1`,
    [rowId],
  );
  assert.deepEqual(after, { status: 'waiting', review_reason: null });
  assert.equal(
    (
      await q(
        `SELECT 1 FROM issues WHERE kind = 'collect_same_bank' AND status = 'open'`,
      )
    ).length,
    0,
  );
  assert.equal((await notices()).length, 1);
  // Released for real now: the sweep moves it to ready.
  assert.equal(
    await ops.releaseWaitingTransfers(database.db, {
      profileId: ADA.id,
      now: new Date(),
    }),
    1,
  );
  // Once: nothing is held any more.
  assert.equal(
    (
      await call('POST', `/v1/ops/collect/same-bank/${ADA.id}/clear`, cookie, {
        reason: REASON,
      })
    ).status,
    409,
  );
  assert.equal((await notices()).length, 1);
});

test('support changes a locked name through the route; nothing moves until the partner checks the new name', async () => {
  await verified(ADA);
  await paidTip(ADA);
  const cookie = await staffWith(null);
  const response = await call('POST', '/v1/ops/collect/name', cookie, {
    handle: ADA.handle,
    first: 'Ada',
    last: 'Bello',
    reason: 'Married name, checked with her ID on a call',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.actedAlone, true);
  const [row] = await q(
    `SELECT collect_legal_name, collect_name_recheck_at IS NOT NULL AS recheck, collect_verified_at IS NOT NULL AS verified
       FROM profiles WHERE id = $1`,
    [ADA.id],
  );
  assert.deepEqual(JSON.parse(row.collect_legal_name), {
    first: 'Ada',
    last: 'Bello',
  });
  assert.equal(row.recheck, true);
  // The lock stays: the recipient still can't change it themselves.
  await assert.rejects(
    ops.recordCollectLegalName(database.db, {
      profileId: ADA.id,
      legalName: { first: 'Someone', last: 'Else' },
    }),
    refusedWith('NAME_LOCKED'),
  );
  // Its bank was checked against the old name: nothing is released, and the bank reads as checking.
  assert.equal(
    await ops.releaseWaitingTransfers(database.db, {
      profileId: ADA.id,
      now: new Date(),
    }),
    0,
  );
  assert.equal(
    await ops.settleCollectVerification(database.db, {
      profileId: ADA.id,
      provider,
      accountReference: 'acct_ada',
      now: new Date(),
    }),
    'checking',
  );
  // Their bank details again, checked by the partner under the new name: transfers move again.
  await q(
    `UPDATE payout_destinations SET replaced_at = now() WHERE profile_id = $1`,
    [ADA.id],
  );
  await q(
    `INSERT INTO payout_destinations (id, profile_id, provider, destination_reference, bank_code, bank_name,
                                      account_last4, status, name_digest)
     VALUES (gen_random_uuid(), $1, 'bachs', 'dest_ada_bello', '058', 'Pretend Guaranty Bank', '1234', 'usable', $2)`,
    [ADA.id, ops.legalNameDigest({ first: 'Ada', last: 'Bello' })],
  );
  assert.equal(
    await ops.settleCollectVerification(database.db, {
      profileId: ADA.id,
      provider,
      accountReference: 'acct_ada',
      now: new Date(),
    }),
    'verified',
  );
  const [cleared] = await q(
    `SELECT collect_name_recheck_at FROM profiles WHERE id = $1`,
    [ADA.id],
  );
  assert.equal(cleared.collect_name_recheck_at, null);
  const [{ status }] = await q(
    `SELECT status FROM collect_transfers WHERE profile_id = $1 AND kind = 'share'`,
    [ADA.id],
  );
  assert.equal(status, 'ready');
  // A page with no verified name is refused (Task 13's NAME_NOT_LOCKED).
  assert.equal(
    (
      await call('POST', '/v1/ops/collect/name', cookie, {
        handle: TOBI.handle,
        first: 'Tobi',
        last: 'Adeyemi',
        reason: 'Checked with them on a call today',
      })
    ).status,
    409,
  );
});

/** A collect refund the partner paid after TipMe had failed it (RI3), with the share already moved. */
async function unbookedRefund() {
  await verified(ADA);
  const { tipId, rowId } = await paidTip(ADA);
  // Sent and paid by the transfer machine, against a stand-in partner: booked as moved.
  await ops.releaseWaitingTransfers(database.db, {
    profileId: ADA.id,
    now: new Date(),
  });
  const run = await ops.runCollectTransfers(database.db, {
    provider: {
      name: 'bachs-sandbox',
      sendCollectTransfer: async () => ({
        transferRef: 'tr_paid',
        status: 'paid',
      }),
      listAccountTransfers: async () => [],
      payoutCapability: async () => ({ status: 'active' }),
    },
    now: new Date(),
  });
  assert.equal(run.paid, 1);
  const [{ status }] = await q(
    `SELECT status FROM collect_transfers WHERE id = $1`,
    [rowId],
  );
  assert.equal(status, 'paid');
  const [{ id: userId }] = await q(
    `SELECT user_id AS id FROM profiles WHERE id = $1`,
    [ADA.id],
  );
  const [{ id: refundId }] = await q(
    `INSERT INTO tip_refunds (id, tip_id, status, amount_minor, currency, provider, provider_reference,
            failure, requested_by, reason, collect_plan, held_minor, recovered_at, refunded_minor)
     VALUES (gen_random_uuid(), $1, 'FAILED', $2, 'NGN', 'bachs', 'platform:cs_gate', 'balance', $3,
             'A refund the partner refused', 'take_back', 0, now(), $2) RETURNING id`,
    [tipId, NET, userId],
  );
  return { tipId, refundId };
}

test('a refund the partner paid unexpectedly is booked once, from what TipMe holds, TipMe absorbing the rest', async () => {
  const { tipId, refundId } = await unbookedRefund();
  assert.equal(
    (await ops.tipRefundFacts(database.db, tipId)).refusal,
    'paid_unbooked',
  );
  const lone = await person();
  const outcome = await ask(lone, 'tip_refund.record_paid', { tipId });
  assert.equal(outcome.state, 'ran', JSON.stringify(outcome));
  const books = await q(
    `SELECT operation_type FROM ledger_transactions WHERE operation_key = $1`,
    [`collect_refund.${refundId}`],
  );
  assert.deepEqual(books, [{ operation_type: 'reversal' }]);
  assert.deepEqual(await unbalanced(), []);
  // Nothing was held for the tip (its share had moved, no transfer back): TipMe absorbed it all.
  const [loss] = await q(
    `SELECT COALESCE(SUM(e.amount_minor), 0)::text AS loss FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.operation_key = $1 AND a.code = 'refund_loss_expense' AND e.side = 'debit'`,
    [`collect_refund.${refundId}`],
  );
  assert.equal(loss.loss, String(NET));
  // The block is gone; the tip's money has gone back, so it can't be refunded again.
  const facts = await ops.tipRefundFacts(database.db, tipId);
  assert.notEqual(facts.refusal, 'paid_unbooked');
  assert.equal(facts.refusal, 'already');
  assert.equal(facts.unbookedMinor, 0n);
  await assert.rejects(
    ask(lone, 'tip_refund.record_paid', { tipId }),
    refusedWith('COLLECT_ACTION_REFUSED'),
  );
});

test('an unexpected refund is booked from the money a transfer back already took for the tip', async () => {
  const { tipId, refundId } = await unbookedRefund();
  // A transfer back had taken it from the recipient's account: TipMe holds it for this tip.
  await q(
    `INSERT INTO collect_transfers (id, kind, tip_id, profile_id, refund_id, account_reference, provider,
            environment, amount_minor, currency, status, idempotency_key, sent_at, paid_at)
     VALUES (gen_random_uuid(), 'back', $1, $2, $3, 'acct_ada', 'bachs', 'sandbox', $4, 'NGN', 'paid',
             $5, now(), now())`,
    [tipId, ADA.id, refundId, NET, `tipme-collect-back-${refundId}`],
  );
  const lone = await person();
  assert.equal(
    (await ask(lone, 'tip_refund.record_paid', { tipId })).state,
    'ran',
  );
  const lines = await q(
    `SELECT a.code, e.side, e.amount_minor::text AS amount FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.operation_key = $1 ORDER BY a.code, e.side`,
    [`collect_refund.${refundId}`],
  );
  assert.deepEqual(lines, [
    { code: 'held_for_recipients', side: 'credit', amount: String(NET) },
    { code: 'recipient_payable', side: 'debit', amount: String(NET) },
  ]);
  assert.deepEqual(await unbalanced(), []);
});

test('evidence is refused after the deadline and submitted once', async () => {
  const { tipId } = await paidTip(ADA);
  const late = await dispute(tipId, {
    respondBy: new Date(Date.now() - 60_000),
  });
  const text =
    'The supporter tipped in person at the event and was given a receipt.';
  const cookie = await staffWith(null);
  assert.equal(
    (
      await call('POST', `/v1/ops/collect/disputes/${late}/evidence`, cookie, {
        text,
        reason: REASON,
      })
    ).status,
    409,
  );
  await q(`DELETE FROM disputes WHERE id = $1`, [late]);

  const disputeId = await dispute(tipId);
  // A file first, through the route (the mock partner keeps it): a real PDF's first bytes.
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(64)]);
  const upload = await fetch(
    `${stack.api}/v1/ops/collect/disputes/${disputeId}/evidence/files`,
    {
      method: 'POST',
      headers: { ...browserHeaders(cookie), 'content-type': 'application/pdf' },
      body: pdf,
    },
  );
  assert.equal(upload.status, 200, await upload.clone().text());
  assert.deepEqual((await upload.json()).data, { files: 1 });
  // Not what it says it is: refused.
  const fake = await fetch(
    `${stack.api}/v1/ops/collect/disputes/${disputeId}/evidence/files`,
    {
      method: 'POST',
      headers: { ...browserHeaders(cookie), 'content-type': 'image/png' },
      body: pdf,
    },
  );
  assert.equal(fake.status, 400);
  const detail = async () =>
    (
      await (
        await call('GET', `/v1/ops/collect/disputes/${disputeId}`, cookie)
      ).json()
    ).data;
  // The real state from TipMe's records.
  assert.equal((await detail()).evidence.state, 'draft');
  const response = await call(
    'POST',
    `/v1/ops/collect/disputes/${disputeId}/evidence`,
    cookie,
    { text, reason: REASON },
  );
  assert.equal(response.status, 200);
  assert.equal((await detail()).evidence.state, 'sending');
  const calls = [];
  const partner = {
    submitDisputeEvidence: async (input) => {
      calls.push(input);
      return { state: 'submitted' };
    },
  };
  for (let i = 0; i < 2; i += 1)
    await ops.sendDisputeEvidence(database.db, {
      provider: partner,
      providerName: 'mock',
      now: new Date(),
    });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, text);
  assert.equal(calls[0].fileRefs.length, 1);
  assert.equal(
    calls[0].idempotencyKey,
    `tipme-dispute-evidence-${disputeId}-1`,
  );
  const sent = await detail();
  assert.equal(sent.evidence.state, 'submitted');
  assert.ok(sent.evidence.submittedAt);
  assert.equal(sent.evidence.canSubmit, false);
  // Once: asking again is refused.
  assert.equal(
    (
      await call(
        'POST',
        `/v1/ops/collect/disputes/${disputeId}/evidence`,
        cookie,
        {
          text,
          reason: REASON,
        },
      )
    ).status,
    409,
  );
});

test('evidence the partner refused can be asked again with a new key; an unknown answer is retried with the same one', async () => {
  const { tipId } = await paidTip(ADA);
  const disputeId = await dispute(tipId);
  const lone = await person();
  const text =
    'The supporter tipped in person at the event and was given a receipt.';
  const late = await dispute(tipId, {
    respondBy: new Date(Date.now() - 60_000),
  });
  await assert.rejects(
    ask(lone, 'collect_dispute.evidence', { disputeId: late, text }),
    refusedWith('COLLECT_EVIDENCE_LATE'),
  );
  await ask(lone, 'collect_dispute.evidence', { disputeId, text });
  const keys = [];
  let answer = 'unknown';
  const partner = {
    submitDisputeEvidence: async (input) => {
      keys.push(input.idempotencyKey);
      if (answer === 'unknown') throw new Error('timeout');
      const refused = new Error('refused');
      refused.name = 'DisputeEvidenceRefusedError';
      throw refused;
    },
  };
  const send = () =>
    ops.sendDisputeEvidence(database.db, {
      provider: partner,
      providerName: 'mock',
      now: new Date(),
    });
  await send();
  answer = 'refused';
  await send();
  const state = async () =>
    (
      await q(`SELECT evidence_state FROM disputes WHERE id = $1`, [disputeId])
    )[0].evidence_state;
  assert.equal(await state(), 'refused');
  assert.deepEqual(keys, [
    `tipme-dispute-evidence-${disputeId}-1`,
    `tipme-dispute-evidence-${disputeId}-1`,
  ]);
  await ask(lone, 'collect_dispute.evidence', { disputeId, text });
  assert.equal(await state(), 'sending');
  answer = 'ok';
  partner.submitDisputeEvidence = async (input) => {
    keys.push(input.idempotencyKey);
    return { state: 'submitted' };
  };
  await send();
  assert.equal(keys.at(-1), `tipme-dispute-evidence-${disputeId}-2`);
  assert.equal(await state(), 'submitted');
});

/* Fix round 1 */

test('C1: a Bachs dispute takes one evidence file; a second upload is refused, and a wrong file can be removed and replaced', async () => {
  const { tipId } = await paidTip(ADA);
  const disputeId = await dispute(tipId, { provider: 'bachs' });
  const cookie = await staffWith(null);
  const detail = async () =>
    (
      await (
        await call('GET', `/v1/ops/collect/disputes/${disputeId}`, cookie)
      ).json()
    ).data;
  assert.equal((await detail()).evidence.maxFiles, 1);
  await ops.addDisputeEvidenceFile(database.db, {
    disputeId,
    fileRef: 'doc_wrong',
    contentType: 'application/pdf',
    bytes: 2048,
    staffUserId: (await q(`SELECT user_id FROM staff LIMIT 1`))[0].user_id,
    now: new Date(),
  });
  // The route refuses before anything reaches the partner.
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(32)]);
  const second = await fetch(
    `${stack.api}/v1/ops/collect/disputes/${disputeId}/evidence/files`,
    {
      method: 'POST',
      headers: { ...browserHeaders(cookie), 'content-type': 'application/pdf' },
      body: pdf,
    },
  );
  assert.equal(second.status, 409);
  // And again under the dispute's lock.
  await assert.rejects(
    ops.addDisputeEvidenceFile(database.db, {
      disputeId,
      fileRef: 'doc_second',
      contentType: 'application/pdf',
      bytes: 10,
      staffUserId: (await q(`SELECT user_id FROM staff LIMIT 1`))[0].user_id,
      now: new Date(),
    }),
    refusedWith('COLLECT_ACTION_REFUSED'),
  );
  // Remove the wrong file (one person, with a reason, audited), add the right one, then submit.
  const removed = await call(
    'POST',
    `/v1/ops/collect/disputes/${disputeId}/evidence/files/0/remove`,
    cookie,
    { reason: 'Uploaded the wrong receipt by mistake' },
  );
  assert.equal(removed.status, 200);
  assert.deepEqual((await detail()).evidence.files, []);
  assert.equal(
    (
      await q(
        `SELECT 1 FROM audit_events WHERE action = 'collect_dispute.file_removed' AND subject_id = $1`,
        [disputeId],
      )
    ).length,
    1,
  );
  await ops.addDisputeEvidenceFile(database.db, {
    disputeId,
    fileRef: 'doc_right',
    contentType: 'application/pdf',
    bytes: 4096,
    staffUserId: (await q(`SELECT user_id FROM staff LIMIT 1`))[0].user_id,
    now: new Date(),
  });
  const submitted = await call(
    'POST',
    `/v1/ops/collect/disputes/${disputeId}/evidence`,
    cookie,
    {
      text: 'The supporter tipped in person at the event and was given a receipt.',
      reason: REASON,
    },
  );
  assert.equal(submitted.status, 200);
  const [row] = await q(
    `SELECT evidence_state, evidence_files FROM disputes WHERE id = $1`,
    [disputeId],
  );
  assert.equal(row.evidence_state, 'sending');
  assert.deepEqual(
    row.evidence_files.map((f) => f.fileRef),
    ['doc_right'],
  );
  // Nothing can be removed once it is being sent.
  assert.equal(
    (
      await call(
        'POST',
        `/v1/ops/collect/disputes/${disputeId}/evidence/files/0/remove`,
        cookie,
        { reason: 'Trying to change it after approval' },
      )
    ).status,
    409,
  );
});

/** A closed dispute whose share had moved: its hold is on the recipient's balance (R4). */
async function closedOnBalance() {
  const { tipId, rowId } = await paidTip(ADA);
  await q(
    `UPDATE collect_transfers SET status = 'paid', paid_at = now(), sent_at = now(),
            account_reference = 'acct_ada' WHERE id = $1`,
    [rowId],
  );
  const disputeId = await dispute(tipId, {
    status: 'closed',
    shareStep: 'balance',
    decidedAt: new Date(Date.now() - 15 * DAY),
  });
  await q(`UPDATE disputes SET held_minor = $2 WHERE id = $1`, [
    disputeId,
    NET,
  ]);
  const [{ user_id: userId }] = await q(
    `SELECT user_id FROM profiles WHERE id = $1`,
    [ADA.id],
  );
  return { tipId, disputeId, userId };
}

/**
 * A refund ask holding the tip row (as askTipRefund does first), committing its refund while the
 * release waits: the release must then see it and refuse, never commit beside it.
 */
async function raceWithRefundAsk({ tipId, userId }, release) {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM tips WHERE id = $1 FOR UPDATE`, [tipId]);
    const racing = release();
    await new Promise((done) => setTimeout(done, 400));
    await client.query(
      `INSERT INTO tip_refunds (id, tip_id, status, amount_minor, currency, provider, provider_reference,
              requested_by, reason, collect_plan)
       VALUES (gen_random_uuid(), $1, 'REQUESTED', $2, 'NGN', 'bachs', 'platform:cs_race', $3,
               'The supporter asked for a refund', 'take_back')`,
      [tipId, NET, userId],
    );
    await client.query('COMMIT');
    return await racing.then(
      () => 'released',
      (error) => error,
    );
  } finally {
    client.release();
  }
}

test('I1: releasing a hold waits for a refund ask holding the tip, then refuses', async () => {
  const fixture = await closedOnBalance();
  const lone = await person();
  const outcome = await raceWithRefundAsk(fixture, () =>
    ask(lone, 'collect_dispute.release_hold', { disputeId: fixture.disputeId }),
  );
  assert.ok(refusedWith('COLLECT_ACTION_REFUSED')(outcome), String(outcome));
  const [row] = await q(
    `SELECT settled_at, held_minor::text AS held FROM disputes WHERE id = $1`,
    [fixture.disputeId],
  );
  assert.deepEqual(row, { settled_at: null, held: String(NET) });
});

test('I1: the 14-day automatic release waits for a refund ask holding the tip, then keeps the hold', async () => {
  const fixture = await closedOnBalance();
  const outcome = await raceWithRefundAsk(fixture, () =>
    ops.advanceDispute(database.db, fixture.disputeId, new Date()),
  );
  assert.equal(outcome, 'released');
  const [row] = await q(
    `SELECT settled_at, held_minor::text AS held FROM disputes WHERE id = $1`,
    [fixture.disputeId],
  );
  assert.deepEqual(row, { settled_at: null, held: String(NET) });
});

test('I2: an unexpected refund is not booked while a return to the recipient is in flight', async () => {
  const { tipId, refundId } = await unbookedRefund();
  await q(
    `INSERT INTO collect_transfers (id, kind, tip_id, profile_id, refund_id, account_reference, provider,
            environment, amount_minor, currency, status, idempotency_key, sent_at, paid_at)
     VALUES (gen_random_uuid(), 'back', $1, $2, $3, 'acct_ada', 'bachs', 'sandbox', $4, 'NGN', 'paid',
             $5, now(), now())`,
    [tipId, ADA.id, refundId, NET, `tipme-collect-back-${refundId}`],
  );
  const [{ id: returnId }] = await q(
    `INSERT INTO collect_transfers (id, kind, tip_id, profile_id, refund_id, account_reference, provider,
            environment, amount_minor, currency, status, idempotency_key)
     VALUES (gen_random_uuid(), 'return', $1, $2, $3, 'acct_ada', 'bachs', 'sandbox', $4, 'NGN', 'ready',
             $5) RETURNING id`,
    [tipId, ADA.id, refundId, NET, `tipme-collect-return-${refundId}`],
  );
  const lone = await person();
  await assert.rejects(
    ask(lone, 'tip_refund.record_paid', { tipId }),
    refusedWith('COLLECT_ACTION_REFUSED'),
  );
  assert.equal(
    (
      await q(`SELECT 1 FROM ledger_transactions WHERE operation_key = $1`, [
        `collect_refund.${refundId}`,
      ])
    ).length,
    0,
  );
  // The return paid: the held money went back to the recipient, so TipMe absorbs the refund.
  await q(
    `UPDATE collect_transfers SET status = 'paid', sent_at = now(), paid_at = now() WHERE id = $1`,
    [returnId],
  );
  assert.equal(
    (await ask(lone, 'tip_refund.record_paid', { tipId })).state,
    'ran',
  );
  const [loss] = await q(
    `SELECT COALESCE(SUM(e.amount_minor), 0)::text AS loss FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.operation_key = $1 AND a.code = 'refund_loss_expense'`,
    [`collect_refund.${refundId}`],
  );
  assert.equal(loss.loss, String(NET));
  assert.deepEqual(await unbalanced(), []);
});

test('I3: after a name change the recipient is told to add their bank details again, and staff see it on Held money', async () => {
  await verified(ADA);
  await paidTip(ADA);
  await q(
    `UPDATE users SET email = $1, email_verified_at = now()
      WHERE id = (SELECT user_id FROM profiles WHERE id = $2)`,
    [`ada.${randomUUID().slice(0, 6)}@example.com`, ADA.id],
  );
  const cookie = await staffWith(null);
  const response = await call('POST', '/v1/ops/collect/name', cookie, {
    handle: ADA.handle,
    first: 'Ada',
    last: 'Bello',
    reason: 'Married name, checked with her ID on a call',
  });
  assert.equal(response.status, 200);
  const notices = await q(
    `SELECT n.title, n.body FROM notifications n JOIN profiles p ON p.user_id = n.user_id
      WHERE p.id = $1 AND n.kind = 'collect_name_recheck'`,
    [ADA.id],
  );
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /Add your bank details again/);
  assert.match(notices[0].body, /our payment partner/);
  assert.doesNotMatch(notices[0].body, /bachs/i);
  const mail = (await queuedMail(database.db, sealing, { limit: 50 })).filter(
    (m) => m.type === 'collect_name_recheck',
  );
  assert.equal(mail.length, 1);
  const held = (
    await (await call('GET', '/v1/ops/collect/held', cookie)).json()
  ).data;
  const ada = held.recipients.find((r) => r.handle === ADA.handle);
  assert.ok(ada.nameRecheckSince);
  const tobi = await paidTip(TOBI).then(async () =>
    (
      await (await call('GET', '/v1/ops/collect/held', cookie)).json()
    ).data.recipients.find((r) => r.handle === TOBI.handle),
  );
  assert.equal(tobi.nameRecheckSince, null);
});

test('minor 1: recording a transfer as paid resolves its review issue', async () => {
  const { rowId, tipId, group } = await paidTip(ADA);
  await q(
    `UPDATE collect_transfers SET status = 'review', review_reason = 'provider', sent_at = now(),
            account_reference = 'acct_ada', attempts = 1 WHERE id = $1`,
    [rowId],
  );
  await ops.openIssue(database.db, {
    dedupeKey: `collect_transfer_review.${rowId}`,
    kind: 'collect_transfer_review',
    subject: { tipId, profileId: ADA.id },
    note: 'The partner shows another amount.',
    now: new Date(),
  });
  listed.set('acct_ada', [
    {
      transferRef: 'tr_ok',
      status: 'paid',
      amountMinor: NET,
      currency: 'NGN',
      group,
    },
  ]);
  const lone = await person();
  assert.equal(
    (await ask(lone, 'collect_transfer.record_paid', { transferId: rowId }))
      .state,
    'ran',
  );
  const [issue] = await q(`SELECT status FROM issues WHERE dedupe_key = $1`, [
    `collect_transfer_review.${rowId}`,
  ]);
  assert.equal(issue.status, 'resolved');
});

/* Task 15 follow-up: the reserve page (Task 11's readings). */

test('the reserve: the latest reading per currency with its level, automatic payouts, and the open reserve issues; collect.view only', async () => {
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);
  const reading = (
    currency,
    available,
    held,
    level,
    minutesAgo,
    w = 50000000,
    c = 25000000,
  ) =>
    q(
      `INSERT INTO collect_reserve_readings (id, provider, currency, available_minor, held_minor, own_minor,
              warning_minor, critical_minor, level, read_at)
       VALUES (gen_random_uuid(), 'bachs', $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        currency,
        available,
        held,
        available === null ? null : String(BigInt(available) - BigInt(held)),
        w,
        c,
        level,
        at(minutesAgo),
      ],
    );
  // NGN: an older reading said ok; the latest is below the warning level.
  await reading('NGN', '200000000', '100000000', 'ok', 30);
  await reading('NGN', '130000000', '100000000', 'warning', 5);
  // USD: held money not covered: the rule broken (stored as `breach`).
  await reading('USD', '1000', '5000', 'breach', 5, 0, 0);
  // EUR: a read that failed: no available, own or level.
  await reading('EUR', null, '0', null, 5, 0, 0);
  await q(
    `INSERT INTO collect_reserve_alerts (id, provider, condition, active, read_at)
     VALUES (gen_random_uuid(), 'bachs', 'auto_payout', false, $1),
            (gen_random_uuid(), 'bachs', 'auto_payout', true, $2)`,
    [at(30), at(5)],
  );
  for (const kind of [
    'collect_auto_payout_on',
    'collect_invariant_broken',
    'collect_own_money_wait',
  ])
    await ops.openIssue(database.db, {
      dedupeKey: `${kind}.${randomUUID()}`,
      kind,
      subject: {},
      note: 'For the reserve page.',
      now: new Date(),
    });
  // Another kind is not the reserve's.
  await ops.openIssue(database.db, {
    dedupeKey: `collect_in_debt.${randomUUID()}`,
    kind: 'collect_in_debt',
    subject: {},
    now: new Date(),
  });

  const outsider = await staffWith(['search.view']);
  assert.equal(
    (await call('GET', '/v1/ops/collect/reserve', outsider)).status,
    403,
  );
  const viewer = await staffWith(['collect.view']);
  const response = await call('GET', '/v1/ops/collect/reserve', viewer);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  const byCurrency = Object.fromEntries(
    data.currencies.map((c) => [c.currency, c]),
  );
  assert.deepEqual(Object.keys(byCurrency).sort(), ['EUR', 'NGN', 'USD']);
  assert.deepEqual(
    {
      available: byCurrency.NGN.availableMinor,
      held: byCurrency.NGN.heldMinor,
      own: byCurrency.NGN.ownMinor,
      level: byCurrency.NGN.level,
      warning: byCurrency.NGN.warningMinor,
      critical: byCurrency.NGN.criticalMinor,
    },
    {
      available: '130000000',
      held: '100000000',
      own: '30000000',
      level: 'warning',
      warning: '50000000',
      critical: '25000000',
    },
  );
  assert.equal(byCurrency.NGN.provider, 'bachs');
  assert.ok(byCurrency.NGN.readAt);
  assert.equal(byCurrency.USD.level, 'broken');
  assert.equal(byCurrency.EUR.level, 'unknown');
  assert.equal(byCurrency.EUR.availableMinor, null);
  // A row written before the read was recorded (no detail): on stays on, never a guessed "off".
  assert.deepEqual(
    data.autoPayouts.map((a) => [a.provider, a.state]),
    [['bachs', 'auto']],
  );
  assert.deepEqual(data.issues.map((i) => i.kind).sort(), [
    'collect_auto_payout_on',
    'collect_invariant_broken',
    'collect_own_money_wait',
  ]);
  for (const issue of data.issues) {
    assert.ok(issue.id && issue.openedAt && issue.summary);
  }
});
