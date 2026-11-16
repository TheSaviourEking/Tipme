import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { enrolOwner, sql, withDatabase } from './ops-helpers';
import { E2E_MAIL_SEAL_KEY } from './stack';

// A page's Pro payments in admin (16 Nov 2026): the history shows whatever the `pro_refunds` money
// switch; with it off the card says so and offers no button; with it on a card month gets a
// reasoned "Refund…" (`pro.refund`, a second person approves). Months are paid on pretend money
// through the database operations with a stand-in partner: nothing reaches a real payment API.

const SHOTS = process.env.STAFF_TOOLS_SHOTS;

/** With STAFF_TOOLS_SHOTS set: the screen at a phone's 390 and a desktop's 1440, for review. */
async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  const size = page.viewportSize();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `${SHOTS}/${name}-${width}.png`,
      fullPage: true,
    });
  }
  if (size) await page.setViewportSize(size);
}

/** A Pro month paid now, by card or bank transfer, recorded as the confirmation would. */
async function paidMonth(profileId: string, method: string) {
  return withDatabase(async (db, ops) => {
    const price = (await ops.currentProPrice(db)).amountMinor as bigint;
    const reference = randomUUID();
    const bought = await ops.buyProByCheckout(db, {
      profileId,
      expectedAmountMinor: price,
      idempotencyKey: randomUUID(),
      provider: {
        async initializePlatformCheckout() {
          return {
            providerReference: `platform:cs_${reference}`,
            checkoutUrl: 'https://checkout.example/session/x',
            expiresAt: new Date(Date.now() + 30 * 60_000),
          };
        },
        async verifyTransaction() {
          throw new Error('not here');
        },
      },
      providerName: 'mock',
      successUrl: 'https://usetipme.xyz/dashboard/settings',
      cancelUrl: 'https://usetipme.xyz/dashboard/settings',
      now: new Date(),
    });
    await ops.confirmProCheckout(db, {
      purchaseId: bought.purchaseId,
      verified: {
        status: 'succeeded',
        amountMinor: price,
        currency: 'NGN',
        feeMinor: 5000n,
        method,
        chargeReference: `ch_${reference.slice(0, 8)}`,
      },
      now: new Date(),
      sealing: ops.mailSealing(Buffer.from(E2E_MAIL_SEAL_KEY, 'base64')),
    });
    return bought.purchaseId as string;
  });
}

const profileIdOf = async (handle: string) =>
  (
    await sql<{ id: string }>(`SELECT id FROM profiles WHERE handle = $1`, [
      handle,
    ])
  )[0]!.id;

/** Written directly: the API catches up within its 15-second switch cache. */
// The e2e reset empties the table, so the row may not exist yet: upsert it.
const setRefunds = (on: boolean) =>
  sql(
    `INSERT INTO feature_switches (key, enabled, source, changed_at, reason)
     VALUES ('pro_refunds', $1, 'staff', now(), 'Set by the e2e test')
     ON CONFLICT (key) DO UPDATE SET enabled = $1, source = 'staff', changed_at = now()`,
    [on],
  );

async function openPage(page: Page, handle: string) {
  await page.goto(`/ops/pages?handle=${handle}`);
  const card = page.getByTestId('pro-payments');
  await expect(card.getByRole('table')).toBeVisible();
  return card;
}

// @alone: the switch is global, so nothing may run beside this test (it also makes the asker the
// only staff member often enough, so either outcome is accepted below).
test('@alone staff read a page’s Pro payments with refunds off, then ask to refund a card month with a reason', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const recipient = await (await browser.newContext()).newPage();
  const who = await signUpRecipient(recipient, testInfo);
  await recipient.close();
  const profileId = await profileIdOf(who.handle);
  await paidMonth(profileId, 'NGN_CARD');
  // The next month paid ahead by bank transfer: never refundable through our payment partner.
  await paidMonth(profileId, 'NGN_BANK_TRANSFER');
  await setRefunds(false);
  try {
    await refundFlow(page, testInfo, who.handle, profileId);
  } finally {
    await setRefunds(false);
  }
});

async function refundFlow(
  page: Page,
  testInfo: Parameters<typeof enrolOwner>[1],
  handle: string,
  profileId: string,
) {
  const who = { handle };
  await enrolOwner(page, testInfo);

  // Off: the history, the plain words, and no button that would only be refused.
  await expect
    .poll(
      async () => {
        const card = await openPage(page, who.handle);
        return card.getByText('Pro refunds aren’t switched on').count();
      },
      { timeout: 30_000, intervals: [2_000] },
    )
    .toBe(1);
  const card = page.getByTestId('pro-payments');
  const rows = card.getByRole('row');
  await expect(rows).toHaveCount(3);
  await expect(card).toContainText('Card');
  await expect(card).toContainText('Bank transfer');
  await expect(card).toContainText(
    'can’t be refunded through our payment partner',
  );
  await expect(card.getByRole('button', { name: /^Refund/ })).toHaveCount(0);
  await expect(card).not.toContainText(/bachs/i);
  await expectAccessible(page);
  await shoot(page, 'pro-payments-off');

  // On: the card month offers "Refund…", which says what happens before anything is asked.
  await setRefunds(true);
  await expect
    .poll(
      async () => {
        await openPage(page, who.handle);
        return card.getByRole('button', { name: /^Refund the / }).count();
      },
      { timeout: 30_000, intervals: [2_000] },
    )
    .toBe(1);
  await card.getByRole('button', { name: /^Refund the / }).click();
  const form = card.getByTestId('pro-refund');
  await expect(form).toContainText('the full amount: TipMe pays the card fee');
  await expect(form).toContainText('ends when our payment partner confirms');
  await form
    .getByLabel('What did the member ask, and how?')
    .fill(
      'The member emailed support on the day they paid and asked for it back.',
    );
  await expectAccessible(page);
  await shoot(page, 'pro-payments-refund');
  await form.getByRole('button', { name: 'Ask for the refund' }).click();
  // Waiting for a second person, or (as the only staff) done alone: never silently.
  await expect(
    card
      .getByTestId('action-outcome')
      .getByText(/Waiting for a second person|Done, without a second person/),
  ).toBeVisible();
  const [asked] = await sql<{ n: number }>(
    `SELECT (SELECT count(*) FROM approval_requests WHERE action = 'pro.refund'
               AND payload->>'purchaseId' IN (SELECT id::text FROM pro_purchases WHERE profile_id = $1))::int
          + (SELECT count(*) FROM pro_refunds r JOIN pro_purchases p ON p.id = r.purchase_id
              WHERE p.profile_id = $1)::int AS n`,
    [profileId],
  );
  expect(asked!.n).toBeGreaterThan(0);
  expect(await fitsViewport(page)).toBe(true);
}

test('@mobile the Pro payments stack as cards on a phone', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const recipient = await (await browser.newContext()).newPage();
  const who = await signUpRecipient(recipient, testInfo);
  await recipient.close();
  const profileId = await profileIdOf(who.handle);
  await paidMonth(profileId, 'NGN_CARD');
  await enrolOwner(page, testInfo);
  const card = await openPage(page, who.handle);
  await expect(card.getByText('Card', { exact: true })).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
  await shoot(page, 'pro-payments');
});
