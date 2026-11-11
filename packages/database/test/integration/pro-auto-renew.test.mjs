import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  buyProByCheckout,
  confirmProCheckout,
  expireDuePeriods,
  mailSealing,
  prepareProAutoRenew,
  proAutoRenewState,
  reconcileProPurchases,
  recordSavedCard,
  renewProAutomatically,
  sendProReminders,
  turnOffProAutoRenew,
} from '../../dist/index.js';
import { UncertainProviderOutcomeError } from '../../../payments/dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

/*
 * Paid Pro, plan Task 10 (ruling 9, behind PRO_AUTO_RENEW): opted into on a card checkout, the
 * saved naira card is charged off-session once, a day before the month ends. A refusal falls back to
 * the normal reminders and grace; nothing is tried again for that month. "Turn off auto-renew" is
 * always there. A pretend partner stands in: nothing here reaches the network.
 */
const sealing = mailSealing(Buffer.alloc(32, 9));
const NOW = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60_000);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function setup(t) {
  const db = await useDatabase(t);
  await db.fresh();
  await db.pool.query(
    `UPDATE users SET email = 'ada@example.com', email_verified_at = now()
       WHERE id = (SELECT user_id FROM profiles WHERE id = $1)`,
    [ADA],
  );
  return db;
}

function partner() {
  const checkouts = [];
  const customers = [];
  const charges = [];
  const reads = new Map();
  return {
    checkouts,
    customers,
    charges,
    reads,
    chargeAnswer: 'pending',
    async createPlatformCustomer(input) {
      customers.push(input);
      return { customerReference: 'cust_1' };
    },
    async initializePlatformCheckout(input) {
      checkouts.push(input);
      return {
        providerReference: `platform:cs_${input.purchaseId}`,
        checkoutUrl: `https://checkout.bachs.io/session/cs_${input.purchaseId}`,
        expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      };
    },
    async chargeSavedCard(input) {
      charges.push(input);
      if (this.chargeAnswer === 'lost')
        throw new UncertainProviderOutcomeError(input.reference, 'lost');
      if (this.chargeAnswer === 'unusable') {
        const error = new Error('unusable');
        error.name = 'SavedCardRefusedError';
        throw error;
      }
      return {
        providerReference: `platform-charge:ch_${charges.length}`,
        status: this.chargeAnswer === 'declined' ? 'failed' : 'pending',
      };
    },
    async verifyTransaction(reference) {
      return (
        reads.get(reference) ?? {
          status: 'pending',
          amountMinor: 250000n,
          currency: 'NGN',
          feeMinor: 0n,
        }
      );
    },
  };
}

const q = (db, text, values = []) =>
  db.pool.query(text, values).then((result) => result.rows);
const planOf = async (db) =>
  (await q(db, `SELECT plan FROM profiles WHERE id = $1`, [ADA]))[0].plan;
const mails = (db, type) =>
  q(db, `SELECT dedupe_key FROM mail_messages WHERE type = $1`, [type]);

/** A month bought now by card with auto-renew ticked; the card saved as the partner reports it. */
async function optedIn(db, fake, { save = true } = {}) {
  const customerReference = await prepareProAutoRenew(db.db, {
    profileId: ADA,
    provider: fake,
    providerName: 'bachs',
  });
  const bought = await buyProByCheckout(db.db, {
    profileId: ADA,
    expectedAmountMinor: 250000n,
    idempotencyKey: randomUUID(),
    provider: fake,
    providerName: 'bachs',
    successUrl: 'https://usetipme.xyz/dashboard/settings',
    cancelUrl: 'https://usetipme.xyz/dashboard/settings',
    saveCard: { customerReference },
    now: NOW,
  });
  await confirmProCheckout(db.db, {
    purchaseId: bought.purchaseId,
    verified: {
      status: 'succeeded',
      amountMinor: 250000n,
      currency: 'NGN',
      feeMinor: 5000n,
      method: 'NGN_CARD',
      chargeReference: 'ch_first',
    },
    now: NOW,
    sealing,
  });
  if (save)
    await recordSavedCard(db.db, {
      provider: 'bachs',
      customerReference,
      paymentMethodReference: 'pm_1',
      now: NOW,
    });
  const [period] = await q(
    db,
    `SELECT id, ends_at, grace_ends_at FROM pro_periods WHERE purchase_id = $1`,
    [bought.purchaseId],
  );
  return { purchaseId: bought.purchaseId, period };
}
const renew = (db, fake, now) =>
  renewProAutomatically(db.db, {
    provider: fake,
    providerName: 'bachs',
    now,
    sealing,
  });

test('opt-in at purchase: a customer once, the checkout saves the card, the saved card turns auto-renew on', async (t) => {
  const db = await setup(t);
  const fake = partner();
  await optedIn(db, fake);
  assert.equal(fake.customers.length, 1);
  assert.equal(fake.customers[0].email, 'ada@example.com');
  assert.deepEqual(fake.checkouts[0].saveCard, { customerReference: 'cust_1' });
  const [row] = await q(db, `SELECT save_card FROM pro_purchases`);
  assert.equal(row.save_card, true);
  assert.deepEqual(await proAutoRenewState(db.db, ADA), {
    on: true,
    cardSaved: true,
  });
  // Asked again, the same customer is used.
  await prepareProAutoRenew(db.db, {
    profileId: ADA,
    provider: fake,
    providerName: 'bachs',
  });
  assert.equal(fake.customers.length, 1);
});

test('a saved card nobody opted into is ignored', async (t) => {
  const db = await setup(t);
  const found = await recordSavedCard(db.db, {
    provider: 'bachs',
    customerReference: 'cust_stranger',
    paymentMethodReference: 'pm_9',
    now: NOW,
  });
  assert.equal(found, null);
});

test('success extends: charged once a day before the end, with tipme-pro-<id>; the read-back queues the next month', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const { period } = await optedIn(db, fake);
  const endsAt = new Date(period.ends_at);
  // Not yet: two days before the end.
  await renew(db, fake, new Date(endsAt.getTime() - 2 * DAY));
  assert.equal(fake.charges.length, 0);
  const at = new Date(endsAt.getTime() - 23 * HOUR);
  await renew(db, fake, at);
  await renew(db, fake, new Date(at.getTime() + HOUR));
  assert.equal(fake.charges.length, 1);
  const [purchase] = await q(
    db,
    `SELECT id, method, status, renews_period_id FROM pro_purchases WHERE method = 'saved_card'`,
  );
  assert.equal(purchase.status, 'PENDING');
  assert.equal(purchase.renews_period_id, period.id);
  assert.equal(fake.charges[0].idempotencyKey, `tipme-pro-${purchase.id}`);
  assert.equal(fake.charges[0].customerReference, 'cust_1');
  assert.equal(fake.charges[0].paymentMethodReference, 'pm_1');
  assert.equal(fake.charges[0].amountMinor, 250000n);
  // Processing is not success: nothing is queued until the read-back says paid.
  assert.equal(
    (await q(db, `SELECT 1 FROM pro_periods WHERE status = 'SCHEDULED'`))
      .length,
    0,
  );
  fake.reads.set('platform-charge:ch_1', {
    status: 'succeeded',
    amountMinor: 250000n,
    currency: 'NGN',
    feeMinor: 5000n,
    method: 'NGN_CARD',
    chargeReference: 'ch_1',
  });
  await reconcileProPurchases(db.db, {
    provider: fake,
    providerName: 'bachs',
    now: new Date(at.getTime() + 10 * 60_000),
    sealing,
    minAgeMs: 0,
  });
  const [next] = await q(
    db,
    `SELECT starts_at, status, paid_by FROM pro_periods WHERE status = 'SCHEDULED'`,
  );
  assert.equal(next.paid_by, 'saved_card');
  assert.equal(new Date(next.starts_at).getTime(), endsAt.getTime());
  assert.equal(
    (await mails(db, 'pro_receipt')).filter(
      (m) => m.dedupe_key === `pro_receipt.${purchase.id}`,
    ).length,
    1,
  );
});

test('failure falls back to grace: one renewal-failed mail, never tried again, the 1-day reminder still goes', async (t) => {
  const db = await setup(t);
  const fake = partner();
  fake.chargeAnswer = 'declined';
  const { period } = await optedIn(db, fake);
  const endsAt = new Date(period.ends_at);
  const at = new Date(endsAt.getTime() - 23 * HOUR);
  await renew(db, fake, at);
  await renew(db, fake, new Date(at.getTime() + 2 * HOUR));
  assert.equal(fake.charges.length, 1);
  assert.equal(
    (
      await q(
        db,
        `SELECT status FROM pro_purchases WHERE method = 'saved_card'`,
      )
    )[0].status,
    'FAILED',
  );
  assert.equal((await mails(db, 'pro_renewal_failed')).length, 1);
  await sendProReminders(db.db, { now: at, sealing, autoRenewOn: true });
  assert.equal(
    (await mails(db, 'pro_renewal_reminder')).filter((m) =>
      m.dedupe_key.endsWith('.1d'),
    ).length,
    1,
  );
  // The month ends into grace as usual, and Pro stays on through it.
  await expireDuePeriods(db.db, {
    now: new Date(endsAt.getTime() + HOUR),
    sealing,
  });
  assert.equal(
    (
      await q(db, `SELECT status FROM pro_periods WHERE id = $1`, [period.id])
    )[0].status,
    'GRACE',
  );
  assert.equal(await planOf(db), 'pro');
});

test('a card that can’t be charged at all fails the renewal the same way', async (t) => {
  const db = await setup(t);
  const fake = partner();
  fake.chargeAnswer = 'unusable';
  const { period } = await optedIn(db, fake);
  await renew(
    db,
    fake,
    new Date(new Date(period.ends_at).getTime() - 23 * HOUR),
  );
  assert.equal((await mails(db, 'pro_renewal_failed')).length, 1);
  assert.equal(
    (
      await q(
        db,
        `SELECT status FROM pro_purchases WHERE method = 'saved_card'`,
      )
    )[0].status,
    'FAILED',
  );
});

test('while auto-renew is on, the 7-day reminder is skipped', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const { period } = await optedIn(db, fake);
  const at = new Date(new Date(period.ends_at).getTime() - 6 * DAY);
  await sendProReminders(db.db, { now: at, sealing, autoRenewOn: true });
  assert.equal((await mails(db, 'pro_renewal_reminder')).length, 0);
  // With the flag off, reminders go as before.
  await sendProReminders(db.db, { now: at, sealing, autoRenewOn: false });
  assert.equal((await mails(db, 'pro_renewal_reminder')).length, 1);
});

test('turn off: nothing is charged, the saved card is forgotten, and reminders come back', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const { period } = await optedIn(db, fake);
  assert.deepEqual(
    await turnOffProAutoRenew(db.db, { profileId: ADA, now: NOW }),
    {
      on: false,
      cardSaved: false,
    },
  );
  await renew(
    db,
    fake,
    new Date(new Date(period.ends_at).getTime() - 23 * HOUR),
  );
  assert.equal(fake.charges.length, 0);
  await sendProReminders(db.db, {
    now: new Date(new Date(period.ends_at).getTime() - 6 * DAY),
    sealing,
    autoRenewOn: true,
  });
  assert.equal((await mails(db, 'pro_renewal_reminder')).length, 1);
});

test('no charge without a saved card, or when the next month is already queued', async (t) => {
  const db = await setup(t);
  const fake = partner();
  const { period } = await optedIn(db, fake, { save: false });
  const at = new Date(new Date(period.ends_at).getTime() - 23 * HOUR);
  await renew(db, fake, at);
  assert.equal(fake.charges.length, 0);
  await recordSavedCard(db.db, {
    provider: 'bachs',
    customerReference: 'cust_1',
    paymentMethodReference: 'pm_1',
    now: NOW,
  });
  await q(
    db,
    `INSERT INTO pro_periods (id, profile_id, starts_at, ends_at, grace_ends_at, status, paid_by, amount_minor, currency)
     VALUES (gen_random_uuid(), $1, $2, $2::timestamptz + interval '30 days', $2::timestamptz + interval '33 days', 'SCHEDULED', 'card', 250000, 'NGN')`,
    [ADA, period.ends_at],
  );
  await renew(db, fake, at);
  assert.equal(fake.charges.length, 0);
});

test('a lost charge answer is asked again only with the same key; the month is charged once', async (t) => {
  const db = await setup(t);
  const fake = partner();
  fake.chargeAnswer = 'lost';
  const { period } = await optedIn(db, fake);
  const at = new Date(new Date(period.ends_at).getTime() - 23 * HOUR);
  await renew(db, fake, at);
  const [purchase] = await q(
    db,
    `SELECT id, status FROM pro_purchases WHERE method = 'saved_card'`,
  );
  assert.equal(purchase.status, 'UNKNOWN');
  fake.chargeAnswer = 'pending';
  await renew(db, fake, new Date(at.getTime() + 10 * 60_000));
  assert.equal(fake.charges.length, 2);
  assert.equal(fake.charges[1].idempotencyKey, fake.charges[0].idempotencyKey);
  assert.equal(
    (
      await q(db, `SELECT status FROM pro_purchases WHERE id = $1`, [
        purchase.id,
      ])
    )[0].status,
    'PENDING',
  );
  assert.equal(
    (await q(db, `SELECT 1 FROM pro_purchases WHERE method = 'saved_card'`))
      .length,
    1,
  );
});
