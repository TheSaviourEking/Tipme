import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createQuote,
  expireDuePeriods,
  findQuoteCharge,
  grantOwner,
  mailSealing,
  setAccountFee,
  setPagePlan,
  startPaidPeriod,
} from '../../dist/index.js';
import { proGraceEnd, proPeriodEnd } from '../../../domain/dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

// The owner's pricing, 12 Nov 2026: the recipient's plan at quote time picks TipMe's share
// (Free 7%, Pro 5%, processing included), stored on the quote so later plan changes never alter it.
const sealing = mailSealing(Buffer.alloc(32, 9));
const START = new Date('2026-11-13T09:00:00.000Z');

async function setup(t) {
  const db = await useDatabase(t);
  await db.fresh();
  const { userId: staff } = await grantOwner(db.db, {
    phone: '+2348000007777',
  });
  return { db, staff };
}
const quoteAda = (db, tipMinor = 1_000_000n, now = undefined) =>
  createQuote(db.db, {
    handle: 'ada',
    tipMinor,
    currency: 'NGN',
    ...(now ? { now } : {}),
  });
const setPlan = (db, staff, plan) =>
  setPagePlan(db.db, {
    staffUserId: staff,
    profileId: ADA,
    plan,
    reason: 'Plan for the fee test',
  });
const share = (b) => b.platformFeeMinor + b.providerFeeMinor;

test('a Free page’s quote keeps 7%, processing included', async (t) => {
  const { db } = await setup(t);
  const quote = await quoteAda(db);
  assert.equal(share(quote.breakdown), 70_000n);
  assert.equal(quote.breakdown.providerFeeMinor, 15_000n);
  assert.equal(quote.breakdown.recipientNetMinor, 930_000n);
  assert.equal(quote.breakdown.payerTotalMinor, 1_000_000n);
  assert.equal(quote.feePolicyVersion, 'v2-free-7pct');
});

test('a Pro page’s quote keeps 5%', async (t) => {
  const { db, staff } = await setup(t);
  await setPlan(db, staff, 'pro');
  const quote = await quoteAda(db);
  assert.equal(share(quote.breakdown), 50_000n);
  assert.equal(quote.breakdown.recipientNetMinor, 950_000n);
  assert.equal(quote.feePolicyVersion, 'v2-pro-5pct');
});

test('a plan change between the quote and the payment never alters the quote', async (t) => {
  const { db, staff } = await setup(t);
  const onFree = await quoteAda(db);
  await setPlan(db, staff, 'pro');
  const onPro = await quoteAda(db);
  await setPlan(db, staff, 'free');
  // What the partner is asked to charge is what each quote showed.
  const freeCharge = await findQuoteCharge(db.db, onFree.quoteId);
  assert.equal(freeCharge.platformFeeMinor + freeCharge.providerFeeMinor, 70_000n);
  const proCharge = await findQuoteCharge(db.db, onPro.quoteId);
  assert.equal(proCharge.platformFeeMinor + proCharge.providerFeeMinor, 50_000n);
  const { rows } = await db.pool.query(
    `SELECT fee_policy_version AS v FROM tip_quotes WHERE id = ANY($1) ORDER BY created_at`,
    [[onFree.quoteId, onPro.quoteId]],
  );
  assert.deepEqual(rows.map((row) => row.v).sort(), [
    'v2-free-7pct',
    'v2-pro-5pct',
  ]);
});

test('a paid Pro month gives 5%, its grace too, and once it lapses the next quote is 7%', async (t) => {
  const { db } = await setup(t);
  await db.db.transaction((tx) =>
    startPaidPeriod(tx, {
      profileId: ADA,
      purchaseId: randomUUID(),
      paidBy: 'card',
      amountMinor: 500_000n,
      currency: 'NGN',
      now: START,
    }),
  );
  assert.equal(share((await quoteAda(db, 1_000_000n, START)).breakdown), 50_000n);
  const end = proPeriodEnd(START);
  const graceEnd = proGraceEnd(end);
  // In grace: still Pro.
  const inGrace = new Date(end.getTime() + 60_000);
  await expireDuePeriods(db.db, { now: inGrace, sealing });
  assert.equal(share((await quoteAda(db, 1_000_000n, inGrace)).breakdown), 50_000n);
  const after = new Date(graceEnd.getTime() + 60_000);
  await expireDuePeriods(db.db, { now: after, sealing });
  const lapsed = await quoteAda(db, 1_000_000n, after);
  assert.equal(share(lapsed.breakdown), 70_000n);
  assert.equal(lapsed.feePolicyVersion, 'v2-free-7pct');
});

test('a quote shown before the release (10%) is charged as shown after it', async (t) => {
  const { db } = await setup(t);
  // What the previous release wrote: V1, 10% of ₦10,000, processing inside it, still open.
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO tip_quotes (id, profile_id, currency, tip_minor, platform_fee_minor,
       provider_fee_minor, payer_total_minor, recipient_net_minor, fee_policy_version,
       waived_platform_fee_minor, expires_at)
     VALUES ($1, $2, 'NGN', 1000000, 85000, 15000, 1000000, 900000, 'proposed-v1.1', 0,
       now() + interval '10 minutes')`,
    [id, ADA],
  );
  const charge = await findQuoteCharge(db.db, id);
  assert.equal(charge.payerTotalMinor, 1_000_000n);
  assert.equal(charge.platformFeeMinor, 85_000n);
  assert.equal(charge.providerFeeMinor, 15_000n);
  // A new quote from this release uses the new rate.
  assert.equal(share((await quoteAda(db)).breakdown), 70_000n);
});

test('an old per-page deal is capped at the plan’s rate; a deal below it stays', async (t) => {
  const { db, staff } = await setup(t);
  const deal = (feeBps) =>
    setAccountFee(db.db, {
      profileId: ADA,
      staffUserId: staff,
      feeBps,
      reason: 'Deal for the fee test',
    });
  // The old 10% written as a deal: Free's 7% applies, and the quote records no deal.
  await deal(1000);
  let quote = await quoteAda(db);
  assert.equal(share(quote.breakdown), 70_000n);
  assert.equal(quote.feePolicyVersion, 'v2-free-7pct');
  // 6% is below Free's 7%: it stands on Free...
  await deal(600);
  quote = await quoteAda(db);
  assert.equal(share(quote.breakdown), 60_000n);
  assert.equal(quote.feePolicyVersion, 'v2-free-7pct-custom-600');
  // ...and is capped at Pro's 5% while the page is on Pro.
  await setPlan(db, staff, 'pro');
  quote = await quoteAda(db);
  assert.equal(share(quote.breakdown), 50_000n);
  assert.equal(quote.feePolicyVersion, 'v2-pro-5pct');
  await deal(300);
  quote = await quoteAda(db);
  assert.equal(share(quote.breakdown), 30_000n);
  assert.equal(quote.feePolicyVersion, 'v2-pro-5pct-custom-300');
});
