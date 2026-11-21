import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { CollectBankController } from '../../apps/api/dist/profiles/collect-bank.controller.js';
import { PayoutDestinationController } from '../../apps/api/dist/profiles/payout-destination.controller.js';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import * as ops from '../../packages/database/dist/index.js';
import {
  openTestDatabase,
  queuedMail,
} from '../../packages/database/dist/test-support.js';
import { newTotpSecret } from '../../packages/domain/dist/index.js';
import { UncertainProviderOutcomeError } from '../../packages/payments/dist/index.js';
import { OPS_TOTP_KEY, setSwitch } from './helpers.mjs';

/*
 * You collect (plan Task 13, spec §2.1 steps 4–5, §8, §10; rulings R7, R8, P12, P13, P22–P26, P32):
 * a recipient on You collect adds their legal name and a bank account in that name at their first
 * withdrawal. Our payment partner compares the bank's name with theirs: names match is verified,
 * some words match goes to the partner's team, no match is refused and nothing is saved. Verified
 * means a usable bank and the account's transfers active: it is set once, the name is locked, the
 * page unpauses and held tips start moving, oldest first. A bank account already used by another
 * recipient sends the second one's transfers to review. Only the last four digits and a keyed hash of
 * the account are kept; the number is never logged. No partner is called: fakes answer.
 */

const [ADA, TOBI] = ops.DEMO_PROFILES;
const SECRET = 'test-auth-code-secret-at-least-32-chars!';
const sealing = ops.mailSealing(Buffer.alloc(32, 7));
const config = {
  PAYMENT_PROVIDER: 'bachs-sandbox',
  WEB_ORIGIN: 'http://127.0.0.1:3000',
  AUTH_CODE_SECRET: SECRET,
};
const GROSS = 1_000_000n; // ₦10,000 on Free: ₦9,500 to the recipient.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(Math.floor(Date.now() / MIN) * MIN);
const ago = (ms) => new Date(NOW.getTime() - ms);
// Built at run time, so no account-number-like literal sits in the source.
const accountNumber = (n) => `${'7'.repeat(8)}${String(n).padStart(2, '0')}`;
const TOBI_NAME = { first: 'Tobi', last: 'Adeyemi' };
const ADA_NAME = { first: 'Ada', last: 'Okafor' };

let database;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
});
after(async () => {
  await setSwitch(database.pool, 'you_collect', false);
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await setSwitch(database.pool, 'you_collect', true);
  // Long-standing recipients: no new-recipient delay (§8), so a share is released at once.
  await q(`UPDATE profiles SET created_at = $1`, [ago(60 * DAY)]);
  for (const profile of [ADA, TOBI])
    await q(
      `UPDATE users SET email = $1, email_verified_at = now() WHERE id = $2`,
      [
        `${profile.handle}.${randomUUID().slice(0, 6)}@example.test`,
        profile.userId,
      ],
    );
});

const collect = (profile) =>
  q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    profile.id,
  ]);

/** A paid collect tip (Task 7's booking: held money and one waiting share), settled at `settledAt`. */
async function paidTip(profile, settledAt) {
  const { db } = database;
  await collect(profile);
  const quote = await ops.createQuote(db, {
    handle: profile.handle,
    tipMinor: GROSS,
    currency: 'NGN',
    now: settledAt,
  });
  assert.equal(quote.collectionMode, 'collect');
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    now: settledAt,
  });
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: `platform:cs_${randomUUID().slice(0, 8)}`,
  });
  await q(`UPDATE payment_attempts SET created_at = $2 WHERE id = $1`, [
    intent.attemptId,
    new Date(settledAt.getTime() - MIN),
  ]);
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
    now: settledAt,
    minAgeMs: 0,
    attemptId: intent.attemptId,
  });
  assert.equal(result.applied, 1);
  const [row] = await q(
    `SELECT id FROM collect_transfers WHERE tip_id = $1 AND kind = 'share'`,
    [intent.tipId],
  );
  return {
    tipId: intent.tipId,
    rowId: row.id,
    key: `tipme-collect-${intent.tipId}`,
  };
}

/**
 * A stand-in for our payment partner: accounts, names, banks and transfers, recording every call.
 * `destinations` scripts the status of each next bank added (usable unless set); `capability` is
 * the accounts' payouts and transfers capability.
 */
function partner(prefix = 'acct_person') {
  const state = {
    nameKeys: new Set(),
    calls: [],
    accounts: new Map(),
    destinations: new Map(),
    next: [],
    capability: 'active',
    createFails: null,
    nameFails: 0,
    moved: new Map(),
    listed: [],
    sendAnswers: [],
  };
  let n = 0;
  const account = (reference) => ({
    accountReference: reference,
    active: false,
    ngnCardCollectionStatus: null,
    bankTransferStatus: null,
    feeCollector: 'platform',
    requirementsDue: [],
    holdsLocalCurrency: state.accounts.get(reference)?.ngn ?? false,
  });
  const provider = {
    name: 'bachs-sandbox',
    environment: 'sandbox',
    capabilities: { connectedAccounts: true },
    async listBanks() {
      return [
        { code: '058', name: 'Pretend Guaranty Bank' },
        { code: '101', name: 'Pretend Providus Bank' },
      ];
    },
    async resolveBankAccount({ accountNumber: number }) {
      state.calls.push(['resolve']);
      return number.startsWith('99') ? null : { accountName: 'TOBI ADEYEMI' };
    },
    async createReceiveOnlyPersonAccount(input) {
      state.calls.push(['create', input.idempotencyKey]);
      if (state.createFails === 'before')
        throw new UncertainProviderOutcomeError(input.idempotencyKey, 'lost', {
          cause: 'no_response',
        });
      n += 1;
      const reference = `${prefix}_${n}`;
      state.accounts.set(reference, { name: null, ngn: false });
      await input.onCreated?.(reference);
      if (state.createFails === 'name')
        throw new UncertainProviderOutcomeError(
          `${input.idempotencyKey}.name`,
          'lost',
          { cause: 'no_response' },
        );
      state.accounts.get(reference).name = input.legalName;
      return account(reference);
    },
    async nameReceiveOnlyPerson(input) {
      state.calls.push(['name', input.accountReference, input.idempotencyKey]);
      if (state.nameFails > 0) {
        state.nameFails -= 1;
        throw new UncertainProviderOutcomeError(input.idempotencyKey, 'lost', {
          cause: 'no_response',
        });
      }
      // As the partner: a key it has seen replays its first answer and applies nothing.
      if (state.nameKeys.has(input.idempotencyKey))
        return account(input.accountReference);
      state.nameKeys.add(input.idempotencyKey);
      const known = state.accounts.get(input.accountReference) ?? {
        ngn: false,
      };
      state.accounts.set(input.accountReference, {
        ...known,
        name: input.legalName,
      });
      return account(input.accountReference);
    },
    async holdLocalCurrency(reference) {
      state.calls.push(['hold', reference]);
      const known = state.accounts.get(reference) ?? { name: null };
      state.accounts.set(reference, { ...known, ngn: true });
      return account(reference);
    },
    async getRecipientAccount(reference) {
      return account(reference);
    },
    async payoutCapability(reference) {
      state.calls.push(['capability', reference]);
      return { status: state.capability, requirementsDue: [] };
    },
    async requestPayoutCapabilities() {},
    async setManualPayouts(reference) {
      state.calls.push(['manual', reference]);
    },
    async addPayoutDestination(reference, input) {
      state.calls.push(['add', reference, input.bankCode]);
      const destinationRef = `dest_${reference}_${input.bankCode}_${input.accountNumber.slice(-4)}`;
      const status = state.next.shift() ?? 'usable';
      state.destinations.set(destinationRef, status);
      return { destinationRef, usable: status === 'usable', status };
    },
    async payoutDestinationStatus(_reference, destinationRef) {
      return state.destinations.get(destinationRef) ?? 'usable';
    },
    // The transfer machine's calls (Task 8): a share moves once per key; the list shows it by group.
    async sendCollectTransfer(input) {
      state.calls.push(['send', input.accountRef, input.idempotencyKey]);
      let transfer = state.moved.get(input.idempotencyKey);
      if (!transfer) {
        transfer = {
          transferRef: `tr_${state.listed.length + 1}`,
          status: 'paid',
          amountMinor: input.amountMinor,
          currency: input.currency,
          group: input.idempotencyKey,
          accountRef: input.accountRef,
        };
        state.moved.set(input.idempotencyKey, transfer);
        state.listed.push(transfer);
      }
      if (state.sendAnswers.shift() === 'lost')
        throw new UncertainProviderOutcomeError(input.idempotencyKey, 'lost', {
          cause: 'no_response',
        });
      return { transferRef: transfer.transferRef, status: 'paid' };
    },
    async listAccountTransfers(reference) {
      state.calls.push(['list', reference]);
      return state.listed
        .filter((transfer) => transfer.accountRef === reference)
        .map((transfer) => ({
          transferRef: transfer.transferRef,
          status: transfer.status,
          amountMinor: transfer.amountMinor,
          currency: transfer.currency,
          group: transfer.group,
        }));
    },
  };
  state.of = (kind) => state.calls.filter(([what]) => what === kind);
  return { provider, state };
}

const partnerCache = { async invalidate() {} };

function controllerFor(provider, logs = []) {
  const logger = {
    info: (entry) => logs.push(entry),
    warn: (entry) => logs.push(entry),
    error: (entry) => logs.push(entry),
  };
  return new CollectBankController(
    config,
    { db: database.db },
    provider,
    logger,
    sealing,
    partnerCache,
  );
}

/** A code sent to the recipient's own address, as the existing bank form asks (one per add). */
async function freshCode(profile) {
  await q(`DELETE FROM email_codes`);
  const { status } = await ops.requestPayoutDestinationCode(
    database.db,
    sealing,
    { userId: profile.userId, secret: SECRET },
  );
  assert.equal(status, 'sent');
  const mails = await queuedMail(database.db, sealing, { limit: 50 });
  return mails.find(
    (mail) =>
      mail.type === 'payout_destination_code' && mail.userId === profile.userId,
  ).data.code;
}

async function addBank(controller, profile, overrides = {}) {
  return controller.add(
    { userId: profile.userId },
    {
      legalName: profile === ADA ? ADA_NAME : TOBI_NAME,
      bankCode: '058',
      accountNumber: accountNumber(1),
      confirmed: true,
      emailCode: await freshCode(profile),
      ...overrides,
    },
  );
}

const refused = async (work) => {
  try {
    await work();
  } catch (error) {
    const body = error.getResponse?.();
    return {
      status: error.getStatus?.(),
      code: body?.code ?? error.code ?? error.name,
    };
  }
  return { status: 'none', code: 'none' };
};

const profileRow = async (profile) =>
  (
    await q(
      `SELECT collect_verified_at, collect_legal_name FROM profiles WHERE id = $1`,
      [profile.id],
    )
  )[0];
const destinations = (profile) =>
  q(
    `SELECT status, account_last4, account_hash, bank_name, replaced_at
       FROM payout_destinations WHERE profile_id = $1 ORDER BY created_at`,
    [profile.id],
  );
const shares = (profile) =>
  q(
    `SELECT c.id, c.status, c.review_reason, c.account_reference, c.sent_at
       FROM collect_transfers c JOIN tips t ON t.id = c.tip_id
      WHERE c.profile_id = $1 AND c.kind = 'share' ORDER BY t.created_at`,
    [profile.id],
  );
const run = (provider, now = new Date()) =>
  ops.runCollectTransfers(database.db, { provider, now });
const notices = (profile, kind = 'collect_verified') =>
  q(`SELECT title, body FROM notifications WHERE user_id = $1 AND kind = $2`, [
    profile.userId,
    kind,
  ]);

test('names match: verified, held tips start moving oldest first, the page unpauses', async () => {
  // Two held tips, the first 31 days ago: past the holding cap's 30 days, so the page is paused.
  const older = await paidTip(TOBI, ago(31 * DAY));
  const newer = await paidTip(TOBI, ago(2 * DAY));
  const before = await ops.collectStatus(database.db, TOBI.id, new Date());
  assert.equal(before.paused, true);
  assert.equal(before.pausedReason, 'days');

  const { provider, state } = partner();
  const logs = [];
  const controller = controllerFor(provider, logs);
  const number = accountNumber(1);

  // The name confirm: the bank's name for the account, and nothing stored.
  assert.deepEqual(
    await controller.lookup(
      { userId: TOBI.userId },
      { legalName: TOBI_NAME, bankCode: '058', accountNumber: number },
    ),
    { data: { bankName: 'TOBI ADEYEMI' } },
  );
  assert.deepEqual(
    await refused(() =>
      controller.lookup(
        { userId: TOBI.userId },
        {
          legalName: TOBI_NAME,
          bankCode: '058',
          accountNumber: `99${'7'.repeat(8)}`,
        },
      ),
    ),
    { status: 422, code: 'BANK_NAME_UNKNOWN' },
  );
  assert.deepEqual(await destinations(TOBI), []);
  assert.equal(state.of('create').length, 0);

  assert.deepEqual(await addBank(controller, TOBI), {
    data: { state: 'verified' },
  });

  // One receive-only person account, its reference kept, holding naira, named, paying out by hand.
  const accounts = await q(
    `SELECT provider_account_reference AS reference, status FROM payment_accounts WHERE profile_id = $1`,
    [TOBI.id],
  );
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].reference, 'acct_person_1');
  assert.equal(state.of('create').length, 1);
  assert.deepEqual(state.accounts.get('acct_person_1'), {
    name: TOBI_NAME,
    ngn: true,
  });
  assert.equal(state.of('manual').length, 1);
  // Held naira before the bank went on (P12), and manual payouts before it too.
  const order = state.calls.map(([what]) => what);
  assert.ok(order.indexOf('hold') < order.indexOf('add'));
  assert.ok(order.indexOf('manual') < order.indexOf('add'));

  const row = await profileRow(TOBI);
  assert.ok(row.collect_verified_at);
  assert.deepEqual(JSON.parse(row.collect_legal_name), TOBI_NAME);
  const [bank] = await destinations(TOBI);
  assert.equal(bank.status, 'usable');
  assert.equal(bank.account_last4, number.slice(-4));
  assert.match(bank.account_hash, /^[0-9a-f]{64}$/);
  assert.ok(!bank.account_hash.includes(number));

  // The page unpauses at once, and held tips are ready to move.
  const after = await ops.collectStatus(database.db, TOBI.id, new Date());
  assert.equal(after.verified, true);
  assert.equal(after.paused, false);
  assert.deepEqual(
    (await shares(TOBI)).map((share) => share.status),
    ['ready', 'ready'],
  );
  const sent = await run(provider);
  assert.equal(sent.paid, 2);
  assert.deepEqual(
    state.of('send').map(([, account, key]) => [account, key]),
    [
      ['acct_person_1', older.key],
      ['acct_person_1', newer.key],
    ],
  );

  // The notice says so, once (P12), in the spec's words.
  assert.deepEqual(await notices(TOBI), [
    {
      title: "You're all set",
      body: "You're all set. Your tips are on their way to you.",
    },
  ]);
  const mail = (await queuedMail(database.db, sealing, { limit: 50 })).filter(
    (m) => m.type === 'collect_verified',
  );
  assert.equal(mail.length, 1);

  // GET /v1/me/collect: the status plus the bank, never the number or the name.
  const view = await controller.status({ userId: TOBI.userId });
  assert.equal(view.data.verified, true);
  assert.equal(view.data.paused, false);
  assert.deepEqual(view.data.bank, {
    state: 'verified',
    last4: number.slice(-4),
    bankName: 'Pretend Guaranty Bank',
  });
  const everything = JSON.stringify([view, logs, state.calls]);
  assert.ok(!everything.includes(number), 'the account number never leaves');
  assert.ok(!JSON.stringify(view).includes('Adeyemi'));

  // Verified once: a repeat add keeps the first verification time (P32).
  await addBank(controller, TOBI);
  assert.deepEqual(
    (await profileRow(TOBI)).collect_verified_at,
    row.collect_verified_at,
  );
  assert.equal((await notices(TOBI)).length, 1);
});

test('some words match: manual review, and a later usable status verifies', async () => {
  const held = await paidTip(TOBI, ago(DAY));
  const { provider, state } = partner();
  const controller = controllerFor(provider);
  state.next.push('pending_review');

  assert.deepEqual(await addBank(controller, TOBI), {
    data: { state: 'manual_review' },
  });
  assert.equal((await profileRow(TOBI)).collect_verified_at, null);
  assert.equal((await shares(TOBI))[0].status, 'waiting');
  assert.deepEqual(
    (await controller.status({ userId: TOBI.userId })).data.bank,
    {
      state: 'manual_review',
      last4: accountNumber(1).slice(-4),
      bankName: 'Pretend Guaranty Bank',
    },
  );
  assert.equal((await run(provider)).sent, 0);

  // The partner's team says yes; its capability.updated event triggers the read-back that decides.
  const [destination] = [...state.destinations.keys()];
  state.destinations.set(destination, 'usable');
  const webhooks = new WebhookService({ db: database.db }, sealing);
  assert.equal(
    await webhooks.applyBachs(
      {
        kind: 'account',
        eventId: `evt_${randomUUID()}`,
        eventType: 'capability.updated',
        accountReference: 'acct_person_1',
      },
      provider,
    ),
    'account_refreshed',
  );
  assert.ok((await profileRow(TOBI)).collect_verified_at);
  assert.equal((await notices(TOBI)).length, 1);
  assert.equal((await shares(TOBI))[0].status, 'ready');
  await run(provider);
  assert.deepEqual(
    state.of('send').map(([, , key]) => key),
    [held.key],
  );
});

test('usable but transfers not yet active is checking, never verified (P12)', async () => {
  await paidTip(TOBI, ago(DAY));
  const { provider, state } = partner();
  state.capability = 'restricted';
  const controller = controllerFor(provider);
  assert.deepEqual(await addBank(controller, TOBI), {
    data: { state: 'checking' },
  });
  assert.equal((await profileRow(TOBI)).collect_verified_at, null);
  assert.equal((await shares(TOBI))[0].status, 'waiting');
  assert.equal(
    (await controller.status({ userId: TOBI.userId })).data.bank.state,
    'checking',
  );
  // The capability goes active: reading the status again finishes the check.
  state.capability = 'active';
  const view = await controller.status({ userId: TOBI.userId });
  assert.equal(view.data.bank.state, 'verified');
  assert.equal(view.data.verified, true);
  assert.equal((await shares(TOBI))[0].status, 'ready');
});

test('no match: refused and nothing is saved', async () => {
  await paidTip(TOBI, ago(DAY));
  const { provider, state } = partner();
  const controller = controllerFor(provider);
  state.next.push('rejected');
  assert.deepEqual(await refused(() => addBank(controller, TOBI)), {
    status: 422,
    code: 'NAME_MISMATCH',
  });
  assert.deepEqual(await destinations(TOBI), []);
  assert.deepEqual(await profileRow(TOBI), {
    collect_verified_at: null,
    collect_legal_name: null,
  });
  assert.equal((await shares(TOBI))[0].status, 'waiting');
  assert.equal(
    (await controller.status({ userId: TOBI.userId })).data.bank,
    null,
  );
  assert.deepEqual(await notices(TOBI), []);
  // Another account in their name is accepted: the same partner account, no second one.
  assert.deepEqual(
    await addBank(controller, TOBI, { accountNumber: accountNumber(2) }),
    { data: { state: 'verified' } },
  );
  assert.equal(state.of('create').length, 1);
});

test('the verified name is locked; changing it needs support', async () => {
  await collect(TOBI);
  const { provider, state } = partner();
  const controller = controllerFor(provider);
  await addBank(controller, TOBI);
  assert.ok((await profileRow(TOBI)).collect_verified_at);

  // Another name is refused before anything reaches the partner; the same name in other case is fine.
  const callsBefore = state.calls.length;
  assert.deepEqual(
    await refused(() =>
      addBank(controller, TOBI, {
        legalName: { first: 'Someone', last: 'Else' },
        accountNumber: accountNumber(3),
      }),
    ),
    { status: 409, code: 'NAME_LOCKED' },
  );
  assert.equal(state.calls.length, callsBefore);
  assert.deepEqual(
    await addBank(controller, TOBI, {
      legalName: { first: 'TOBI', last: 'adeyemi' },
      accountNumber: accountNumber(4),
    }),
    { data: { state: 'verified' } },
  );

  // Support's serious action changes it, audited, and a staff member can't approve their own.
  const key = Buffer.from(OPS_TOTP_KEY, 'base64');
  await ops.ensureOwnerRole(database.db);
  ops.registerRealSeriousActions();
  const [{ id: staffId }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`support.${randomUUID().slice(0, 6)}@example.com`],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
    [staffId],
  );
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [staffId, ops.sealSecret(key, newTotpSecret())],
  );
  const [{ id: sessionId }] = await q(
    `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day') RETURNING id`,
    [staffId, randomBytes(32).toString('hex')],
  );
  const [{ id: grantId }] = await q(
    `INSERT INTO ops_sessions (id, user_id, session_id, token_sha256, created_at, last_seen_at, expires_at, last_totp_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now(), now() + interval '1 hour', now()) RETURNING id`,
    [staffId, sessionId, randomBytes(32).toString('hex')],
  );
  const ask = (payload) =>
    ops.requestSeriousAction(database.db, {
      name: 'collect_name.change',
      payload,
      actorId: staffId,
      grantId,
      reason: 'Married name, checked against their ID by support',
      services: { sealing, authCodeSecret: SECRET },
    });
  // Ada is not on You collect, so there is no verified name to change.
  await assert.rejects(ask({ profileId: ADA.id, first: 'Ada', last: 'Eze' }), {
    code: 'NAME_NOT_LOCKED',
  });
  const outcome = await ask({
    profileId: TOBI.id,
    first: 'Tobi',
    last: 'Bello',
  });
  assert.equal(outcome.state, 'ran');
  assert.deepEqual(JSON.parse((await profileRow(TOBI)).collect_legal_name), {
    first: 'Tobi',
    last: 'Bello',
  });
  const audit = await q(
    `SELECT action, subject_id, reason FROM audit_events WHERE action = 'collect_name.changed'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].subject_id, TOBI.id);
  assert.ok(!audit[0].reason.includes('Bello'), 'the name is not in the log');
  // The new name is the one now accepted, and our payment partner is told it.
  assert.deepEqual(
    await addBank(controller, TOBI, {
      legalName: { first: 'Tobi', last: 'Bello' },
      accountNumber: accountNumber(5),
    }),
    { data: { state: 'verified' } },
  );
  assert.deepEqual(state.accounts.get('acct_person_1').name, {
    first: 'Tobi',
    last: 'Bello',
  });
});

test('a transfer waits while the destination is pending review, and a shared bank account sends the second recipient to review', async () => {
  const { provider, state } = partner();
  const controller = controllerFor(provider);
  const first = await paidTip(TOBI, ago(3 * DAY));
  await addBank(controller, TOBI);
  // The first share is sent, and its answer is lost (P26: it may have moved).
  state.sendAnswers.push('lost');
  await run(provider);
  const [inFlight] = await shares(TOBI);
  assert.equal(inFlight.status, 'unknown');
  assert.equal(inFlight.account_reference, 'acct_person_1');

  // Then a new tip, and Tobi changes the bank; the new one is under review.
  const second = await paidTip(TOBI, ago(DAY));
  state.next.push('pending_review');
  assert.deepEqual(
    await addBank(controller, TOBI, { accountNumber: accountNumber(6) }),
    { data: { state: 'manual_review' } },
  );
  assert.equal(
    (await controller.status({ userId: TOBI.userId })).data.bank.state,
    'manual_review',
  );
  // A run later: nothing is sent while the bank is pending. The lost one keeps the account its key
  // went to (P26), never redirected, and is not sent again.
  const later = new Date(Date.now() + 30 * MIN);
  await ops.releaseWaitingTransfers(database.db, { now: later });
  await run(provider, later);
  let rows = await shares(TOBI);
  assert.equal(rows[0].status, 'unknown');
  assert.equal(rows[0].account_reference, 'acct_person_1');
  assert.equal(
    state.of('send').filter(([, , key]) => key === first.key).length,
    1,
  );
  // Once the partner may have forgotten the key, the read-back on that same account settles it.
  const dayLater = new Date(Date.now() + 25 * HOUR);
  await run(provider, dayLater);
  rows = await shares(TOBI);
  assert.equal(rows[0].status, 'paid');
  assert.equal(rows[0].account_reference, 'acct_person_1');
  assert.ok(
    state.of('list').some(([, account]) => account === 'acct_person_1'),
  );
  assert.equal(state.listed.filter((t) => t.group === first.key).length, 1);
  assert.equal(rows[1].status, 'waiting');
  assert.ok(!state.of('send').some(([, , key]) => key === second.key));

  // Ada adds the same bank account: her name matches, but the account is Tobi's too.
  await paidTip(ADA, ago(DAY));
  const ada = partner('acct_ada');
  const adaController = controllerFor(ada.provider);
  assert.deepEqual(
    await addBank(adaController, ADA, { accountNumber: accountNumber(1) }),
    { data: { state: 'verified' } },
  );
  const [adaBank] = await destinations(ADA);
  const tobiBanks = await destinations(TOBI);
  // Tobi's first bank (since replaced) is the same account; his new one is not.
  assert.deepEqual(
    tobiBanks.map((bank) => bank.account_hash === adaBank.account_hash),
    [true, false],
  );
  const [adaShare] = await shares(ADA);
  assert.equal(adaShare.status, 'review');
  assert.equal(adaShare.review_reason, 'same_bank');
  const issues = await q(
    `SELECT kind, status, subject FROM issues WHERE kind = 'collect_same_bank'`,
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].subject.profileId, ADA.id);
  // Nothing goes to Ada until staff clear it, including a tip that arrives later.
  const adaLater = await paidTip(ADA, ago(HOUR));
  await ops.releaseWaitingTransfers(database.db, { now: later });
  await run(ada.provider, later);
  assert.equal(ada.state.of('send').length, 0);
  assert.equal(
    (await shares(ADA)).find((s) => s.id === adaLater.rowId).status,
    'waiting',
  );
  // Tobi, the first to use it, is not held for it.
  assert.equal(
    (
      await q(`SELECT 1 FROM issues WHERE subject->>'profileId' = $1`, [
        TOBI.id,
      ])
    ).length,
    0,
  );
});

test('an existing never-verified recipient reuses their account row', async () => {
  // Tobi started setting up before You collect: an account that never finished onboarding (R7, P22).
  await ops.beginPaymentAccountCreation(database.db, {
    profileId: TOBI.id,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await ops.updatePaymentAccountStatus(database.db, {
    sealing,
    profileId: TOBI.id,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_tobi_old',
    status: 'ONBOARDING',
    chargesEnabled: false,
    payoutsEnabled: false,
    feeCollector: 'platform',
    requirementsDue: [],
  });
  await paidTip(TOBI, ago(DAY));
  const { provider, state } = partner();
  const controller = controllerFor(provider);
  assert.deepEqual(await addBank(controller, TOBI), {
    data: { state: 'verified' },
  });
  assert.equal(state.of('create').length, 0);
  assert.deepEqual(
    state.of('name').map(([, account]) => account),
    ['acct_tobi_old'],
  );
  assert.deepEqual(state.of('hold'), [['hold', 'acct_tobi_old']]);
  assert.deepEqual(
    state.of('add').map(([, account]) => account),
    ['acct_tobi_old'],
  );
  const accounts = await q(
    `SELECT provider_account_reference AS reference FROM payment_accounts WHERE profile_id = $1`,
    [TOBI.id],
  );
  assert.deepEqual(accounts, [{ reference: 'acct_tobi_old' }]);
  assert.equal((await shares(TOBI))[0].account_reference, 'acct_tobi_old');
});

test('a retry after the name was lost names the kept account and never creates a second', async () => {
  await collect(TOBI);
  const { provider, state } = partner();
  const controller = controllerFor(provider);
  state.createFails = 'name';
  const failed = await refused(() => addBank(controller, TOBI));
  assert.equal(failed.status, 503);
  // The reference was kept the moment create answered.
  assert.deepEqual(
    await q(
      `SELECT provider_account_reference AS reference FROM payment_accounts WHERE profile_id = $1`,
      [TOBI.id],
    ),
    [{ reference: 'acct_person_1' }],
  );
  assert.equal((await profileRow(TOBI)).collect_legal_name, null);
  state.createFails = null;
  assert.deepEqual(await addBank(controller, TOBI), {
    data: { state: 'verified' },
  });
  assert.equal(state.of('create').length, 1);
  assert.deepEqual(
    state.of('name').map(([, account]) => account),
    ['acct_person_1'],
  );

  // A create whose answer was lost leaves the account unknown for staff: never a second create.
  await q(`UPDATE profiles SET collect_verified_at = NULL WHERE id = $1`, [
    ADA.id,
  ]);
  await collect(ADA);
  const ada = partner();
  ada.state.createFails = 'before';
  const adaController = controllerFor(ada.provider);
  assert.deepEqual(await refused(() => addBank(adaController, ADA)), {
    status: 503,
    code: 'PROVIDER_OUTCOME_UNKNOWN',
  });
  assert.deepEqual(await refused(() => addBank(adaController, ADA)), {
    status: 503,
    code: 'PROVIDER_OUTCOME_UNKNOWN',
  });
  assert.equal(ada.state.of('create').length, 1);
});

test('another person’s profile, a direct recipient, or the switch off with mode null: 404', async () => {
  const { provider, state } = partner();
  const controller = controllerFor(provider);
  const lookup = {
    legalName: ADA_NAME,
    bankCode: '058',
    accountNumber: accountNumber(1),
  };
  // Ada is undecided (null) and the switch is on: not on You collect, so none of this is hers.
  for (const [who, setUp] of [
    ['undecided, switch on', async () => {}],
    [
      'direct',
      () =>
        q(`UPDATE profiles SET collection_mode = 'direct' WHERE id = $1`, [
          ADA.id,
        ]),
    ],
    [
      'undecided, switch off',
      async () => {
        await q(`UPDATE profiles SET collection_mode = NULL WHERE id = $1`, [
          ADA.id,
        ]);
        await setSwitch(database.pool, 'you_collect', false);
      },
    ],
  ]) {
    await setUp();
    for (const call of [
      () => controller.status({ userId: ADA.userId }),
      () => controller.lookup({ userId: ADA.userId }, lookup),
      () => addBank(controller, ADA),
    ])
      assert.deepEqual(
        await refused(call),
        { status: 404, code: 'NOT_FOUND' },
        who,
      );
  }
  assert.equal(state.calls.length, 0);

  // Each recipient only ever reaches their own: Tobi's add never touches Ada, and a body naming a
  // profile is refused by the schema (the route has no profile in it).
  await setSwitch(database.pool, 'you_collect', true);
  await collect(TOBI);
  await addBank(controller, TOBI);
  assert.deepEqual(await destinations(ADA), []);
  const { collectBankAddSchema } =
    await import('../../packages/contracts/dist/index.js');
  assert.equal(
    collectBankAddSchema.safeParse({
      legalName: TOBI_NAME,
      bankCode: '058',
      accountNumber: accountNumber(1),
      confirmed: true,
      emailCode: '123456',
      profileId: ADA.id,
    }).success,
    false,
  );

  // An existing collect recipient keeps working with the switch off (§12.5).
  await setSwitch(database.pool, 'you_collect', false);
  assert.equal(
    (await controller.status({ userId: TOBI.userId })).data.mode,
    'collect',
  );

  // And the old bank form is not a way round the name check for a collect recipient.
  const old = new PayoutDestinationController(
    config,
    { db: database.db },
    provider,
    { info() {}, warn() {}, error() {} },
    sealing,
    partnerCache,
  );
  assert.deepEqual(
    await refused(() =>
      old.update(
        { userId: TOBI.userId },
        {
          bankCode: '058',
          accountNumber: accountNumber(7),
          accountName: 'SOMEONE ELSE',
          emailCode: '123456',
        },
      ),
    ),
    { status: 404, code: 'NOT_FOUND' },
  );
});

// Fix round 1 (review C1, I1, I2, M2, M6): a name is verified only once our payment partner has
// checked it against the bank that is current; the partner's record follows TipMe's.

const REAL = { first: 'Real', last: 'Holder' };
const partnerName = (state, reference = 'acct_person_1') =>
  state.accounts.get(reference)?.name;

test('a later add that fails after the rename never verifies the new name on the old bank (C1)', async () => {
  await paidTip(TOBI, ago(DAY));
  const { provider, state } = partner();
  state.capability = 'restricted';
  const controller = controllerFor(provider);
  assert.deepEqual(await addBank(controller, TOBI, { legalName: REAL }), {
    data: { state: 'checking' },
  });
  const realAdd = provider.addPayoutDestination;
  for (const failure of ['add', 'hold']) {
    if (failure === 'add')
      provider.addPayoutDestination = async () => {
        throw new Error('partner down');
      };
    else
      provider.holdLocalCurrency = async () => {
        throw new Error('partner down');
      };
    const answer = await refused(() =>
      addBank(controller, TOBI, { accountNumber: accountNumber(2) }),
    );
    assert.equal(answer.status, 503, failure);
    provider.addPayoutDestination = realAdd;
    delete provider.holdLocalCurrency;
    provider.holdLocalCurrency = partner().provider.holdLocalCurrency;
    // TipMe and the partner both still hold the name the bank was checked against.
    assert.deepEqual(
      JSON.parse((await profileRow(TOBI)).collect_legal_name),
      REAL,
    );
    assert.deepEqual(partnerName(state), REAL);
  }
  state.capability = 'active';
  const view = await controller.status({ userId: TOBI.userId });
  assert.equal(view.data.verified, true);
  assert.deepEqual(
    JSON.parse((await profileRow(TOBI)).collect_legal_name),
    REAL,
  );
  assert.equal(view.data.bank.last4, accountNumber(1).slice(-4));
});

test('a replayed usable answer for the same number never certifies a different name (C1)', async () => {
  await paidTip(TOBI, ago(DAY));
  const { provider, state } = partner();
  state.capability = 'restricted';
  const controller = controllerFor(provider);
  await addBank(controller, TOBI, { legalName: REAL });
  // Within the partner's window the add replays its first answer, decided against REAL.
  provider.addPayoutDestination = async (reference, input) => {
    const destinationRef = `dest_${reference}_${input.bankCode}_${input.accountNumber.slice(-4)}`;
    const status = state.destinations.get(destinationRef);
    return { destinationRef, usable: status === 'usable', status };
  };
  const answer = await refused(() => addBank(controller, TOBI));
  assert.equal(answer.status, 503);
  state.capability = 'active';
  await controller.status({ userId: TOBI.userId });
  const row = await profileRow(TOBI);
  // Verified, if at all, only with the name the bank was checked against.
  assert.deepEqual(JSON.parse(row.collect_legal_name), REAL);
  assert.deepEqual(partnerName(state), REAL);
});

test('a refused add leaves the partner holding the name TipMe holds (I2)', async () => {
  await paidTip(TOBI, ago(DAY));
  const { provider, state } = partner();
  state.capability = 'restricted';
  const controller = controllerFor(provider);
  await addBank(controller, TOBI);
  state.next.push('rejected');
  assert.deepEqual(
    await refused(() =>
      addBank(controller, TOBI, {
        legalName: { first: 'Some', last: 'Stranger' },
        accountNumber: accountNumber(2),
      }),
    ),
    { status: 422, code: 'NAME_MISMATCH' },
  );
  assert.deepEqual(
    JSON.parse((await profileRow(TOBI)).collect_legal_name),
    TOBI_NAME,
  );
  assert.deepEqual(partnerName(state), TOBI_NAME);
});

test('the partner name is written per change, so X then Y then X holds X; an unchanged name is not sent (I1)', async () => {
  await paidTip(TOBI, ago(DAY));
  const { provider, state } = partner();
  state.capability = 'restricted';
  const controller = controllerFor(provider);
  const Y = { first: 'Tobi', last: 'Adeyemii' };
  await addBank(controller, TOBI, { accountNumber: accountNumber(1) });
  // The same name again: nothing to write.
  await addBank(controller, TOBI, { accountNumber: accountNumber(1) });
  assert.equal(state.of('name').length, 0);
  await addBank(controller, TOBI, {
    legalName: Y,
    accountNumber: accountNumber(2),
  });
  assert.deepEqual(partnerName(state), Y);
  await addBank(controller, TOBI, { accountNumber: accountNumber(3) });
  assert.deepEqual(partnerName(state), TOBI_NAME);
  const keys = state.of('name').map(([, , key]) => key);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
  state.capability = 'active';
  assert.equal(
    (await controller.status({ userId: TOBI.userId })).data.verified,
    true,
  );
  assert.deepEqual(
    JSON.parse((await profileRow(TOBI)).collect_legal_name),
    TOBI_NAME,
  );
});

test('an open shared-bank issue alone holds a tip that arrives after the bank was added (M2)', async () => {
  await collect(TOBI);
  const { provider } = partner();
  await addBank(controllerFor(provider), TOBI);
  // Ada has nothing waiting when she adds Tobi's account, so no row moves to review.
  await collect(ADA);
  const ada = partner('acct_ada');
  await addBank(controllerFor(ada.provider), ADA);
  assert.deepEqual(await shares(ADA), []);
  const later = await paidTip(ADA, ago(HOUR));
  await ops.releaseWaitingTransfers(database.db, { now: new Date() });
  await run(ada.provider);
  assert.equal(
    (await shares(ADA)).find((share) => share.id === later.rowId).status,
    'waiting',
  );
  assert.equal(ada.state.of('send').length, 0);
});

test("a collect recipient's bank is never set without the name check (M6)", async () => {
  await collect(TOBI);
  await assert.rejects(
    ops.setPayoutDestination(database.db, {
      sealing,
      profileId: TOBI.id,
      provider: 'bachs',
      destinationRef: 'dest_direct',
      bankCode: '058',
      bankName: 'Pretend Guaranty Bank',
      last4: '1234',
      status: 'usable',
    }),
    { code: 'NAME_LOCKED' },
  );
});
