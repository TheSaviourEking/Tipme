import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { startTip } from '../shared/tip-flow';
import { chooseBank } from './bank-fixtures';
import {
  accountOf,
  seedAgreement,
  seedBusiness,
  seedMember,
} from './business-fixtures';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import { API_ORIGIN } from './stack';

// Business release 2, PR R2-B: an owner sees the business's own balance (its share of tips), adds
// the business's bank with a code, and withdraws it. Pretend payouts only. The e2e stack runs with
// BUSINESS_ENABLED and BUSINESS_SHARES_ENABLED on (playwright.config.ts).

const hintOf = (email: string) => {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

/** The newest bank-account code email to this address, once it has arrived. */
async function bankCode(page: Page, email: string) {
  const inbox = await page.context().newPage();
  try {
    let found = '';
    await expect(async () => {
      await inbox.goto('/dev/inbox');
      await expect(inbox.getByRole('article').first()).toBeVisible();
      const mails = await inbox
        .getByRole('article')
        .filter({ hasText: hintOf(email) })
        .filter({ hasText: 'Confirm your TipMe bank account' })
        .allTextContents();
      found = /\b(\d{6})\b/.exec(mails[0] ?? '')?.[1] ?? '';
      expect(found).not.toBe('');
    }).toPass({ timeout: 15_000 });
    return found;
  } finally {
    await inbox.close();
  }
}

test('an owner sees the business balance, adds its bank and withdraws it', async ({
  page,
  request,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({ owner: userId });
  // The owner also works there, and shares half of what they receive at the business.
  const { memberId } = await seedMember({
    locationId: business.locations[0]!.id,
    profileId,
    shownName: 'Kemi',
  });
  const { agreementId } = await seedAgreement({
    memberId,
    proposedByUser: userId,
    businessBps: 5000,
  });

  // A ₦40,000 tip at the business, through the API the tip page uses: the quote tells the split
  // before paying, and the intent fixes the share on the tip (R2-C2).
  const quote = await (
    await request.post(`${API_ORIGIN}/v1/tip-quotes`, {
      data: {
        handle: who.handle,
        amountMinor: '4000000',
        currency: 'NGN',
        businessMemberId: memberId,
      },
    })
  ).json();
  expect(quote.data.share).toEqual({
    personKeepsPercent: 50,
    businessPercent: 50,
    businessName: 'The Yellow Chilli',
  });
  const intent = await (
    await request.post(`${API_ORIGIN}/v1/tip-intents`, {
      headers: { 'idempotency-key': randomUUID() },
      data: { quoteId: quote.data.quoteId, businessMemberId: memberId },
    })
  ).json();
  const share = (BigInt(quote.data.recipientNetMinor) * 5000n) / 10000n;
  const [fixed] = await sql<{ share: string; agreement_id: string }>(
    'SELECT share_minor::text AS share, agreement_id FROM tip_business_shares WHERE tip_id = $1',
    [intent.data.tipId],
  );
  expect(fixed).toEqual({ share: share.toString(), agreement_id: agreementId });
  const reference = String(intent.data.checkoutUrl).split('/mock-checkout/')[1];
  await request.post(`${API_ORIGIN}/v1/mock-provider/checkout/${reference}`, {
    data: { outcome: 'succeed' },
  });
  // As the web's formatNaira writes it: kobo only when there are some.
  const naira = (minor: bigint) => {
    const kobo = minor % 100n;
    return `₦${new Intl.NumberFormat('en').format(minor / 100n)}${kobo ? `.${String(kobo).padStart(2, '0')}` : ''}`;
  };
  const shareText = naira(share);
  // The business pays the ₦50 transfer fee from the amount (owner, 12 Nov 2026).
  const receiveText = naira(share - 5000n);

  // Every read is the real API (B1's business detail included); all money calls are real.
  const money = page.locator('#money');
  await expect(async () => {
    await page.goto('/dashboard/business');
    await expect(money.getByTestId('business-balance')).toHaveText(shareText, {
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });
  // Option B: the share waits to move to the business's own account until its tip has settled.
  await expect(money.getByTestId('business-on-the-way')).toContainText(
    `On its way: ${shareText}`,
  );
  await expect(
    money.getByText(/The smallest withdrawal for a business is ₦2,000/),
  ).toBeVisible();
  // As for a person, the pretend partner pays without a bank on file ("Pretend bank").
  await expect(money.getByText('Ready to withdraw')).toBeVisible();
  await expect(money.getByText(/Pretend bank ••0000/)).toBeVisible();

  const bank = money.locator('#business-bank');
  await chooseBank(bank, 'guaranty', 'Pretend Guaranty Bank');
  await bank.getByLabel('Account number').fill('0123456789');
  await expect(bank.getByLabel('Name on the account')).toHaveValue(
    'PRETEND ACCOUNT HOLDER',
  );
  await bank.getByRole('button', { name: 'Email me a code' }).click();
  await bank.getByLabel('6-digit code').fill(await bankCode(page, who.email));
  await bank.getByRole('button', { name: 'Save bank account' }).click();
  await expect(bank.getByText('Usable')).toBeVisible();

  // The quote is read once per visit: a new visit sees the bank.
  await page.reload();
  await expect(money.getByText('Ready to withdraw')).toBeVisible();
  await expect(
    money.getByText(/Pretend Guaranty Bank ••6789/).first(),
  ).toBeVisible();
  await expect(money).toContainText(
    'The ₦50 transfer fee comes off the amount you withdraw.',
  );
  await expectAccessible(page);

  await money.getByRole('button', { name: 'Everything' }).click();
  await expect(money.getByTestId('business-you-receive')).toHaveText(
    `Transfer fee: ₦50, charged by our payment partner. It comes off the amount: the business receives ${receiveText}. If the fee is different, the difference is settled on the business’s balance.`,
  );
  await money.getByRole('button', { name: /^Withdraw ₦/ }).click();
  await expect(money.getByText('Withdrawal requested')).toBeVisible();
  await expect(money).toContainText(
    `${receiveText} is on its way to the business’s bank.`,
  );
  await expect(money.getByTestId('business-balance')).toHaveText('₦0');
  const [payout] = await sql<{
    business_id: string;
    profile_id: string | null;
    sent: string;
    fee: string;
  }>(
    'SELECT business_id, profile_id, amount_minor::text AS sent, user_fee_minor::text AS fee FROM payouts WHERE business_id = $1',
    [business.businessId],
  );
  expect(payout).toEqual({
    business_id: business.businessId,
    profile_id: null,
    sent: (share - 5000n).toString(),
    fee: '5000',
  });
  await expect(page.locator('body')).not.toContainText(/bachs|TipMe pays/i);
  expect(await fitsViewport(page)).toBe(true);

  // The staff member (the owner works there too) sees what they shared, on their Work page.
  await page.goto('/dashboard/work');
  const shared = page.getByTestId('work-shared');
  await expect(shared).toContainText(
    `This month you shared ${shareText} with The Yellow Chilli, from 1 tip.`,
  );
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);
});

// Owner, 12 and 14 Nov 2026: the business pays the ₦50 transfer fee from the amount, and its
// minimum is the minimum tip (₦2,000): it may take everything it has under that (not part of it),
// and nothing when that is ₦50 or less.
test('under ₦2,000 a business may take everything, less the ₦50 fee; ₦50 or less, it is told why', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  const { userId } = await accountOf(who.email);
  const business = await seedBusiness({ owner: userId });
  // Hold the balance at ₦1,800, the sandbox share of a ₦10,000 tip at 80/20; later at ₦50.
  let held = '180000';
  await page.route(
    `**/v1/me/businesses/${business.businessId}/balance`,
    (route) =>
      route.fulfill({
        json: {
          data: {
            businessId: business.businessId,
            currency: 'NGN',
            balanceMinor: held,
            canWithdraw: true,
            onTheWayMinor: '0',
            heldBackMinor: '180000',
            minWithdrawalMinor: '200000',
            payoutAccount: 'not_needed',
          },
        },
      }),
  );
  await page.route(
    `**/v1/me/businesses/${business.businessId}/withdrawal-quote`,
    (route) =>
      route.fulfill({
        json: {
          data: {
            state: 'ready',
            withdrawableMinor: held,
            ledgerMinor: held,
            providerMinor: held,
            feeMinor: '5000',
            feePaidBy: 'user',
            destination: { bankName: 'Pretend bank', last4: '0000' },
            inReview: false,
          },
        },
      }),
  );
  // The fee went up meanwhile: the API refuses, and the page says why in plain words.
  await page.route(
    `**/v1/me/businesses/${business.businessId}/withdrawals`,
    (route) =>
      route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'WITHDRAWAL_BELOW_FEE',
            message: 'refused',
            requestId: 'test',
          },
        },
      }),
  );
  await page.route('**/v1/me/events', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.goto('/dashboard/business');
  const money = page.locator('#money');
  await expect(money.getByTestId('business-balance')).toHaveText('₦1,800');
  await expect(
    money.getByText('Held back from the next shares', { exact: true }),
  ).toBeVisible();
  await expect(money).toContainText(
    '₦1,800 will be taken from the business’s next shares',
  );
  await expect(money).toContainText(
    'The smallest withdrawal for a business is ₦2,000, or everything it has.',
  );
  // Part of it, under the minimum: the button can't send it.
  await money.getByLabel('Amount (NGN)').fill('1000');
  await expect(
    money.getByRole('button', { name: 'Withdraw ₦1,000' }),
  ).toBeDisabled();
  await expect(money.getByTestId('business-you-receive')).toHaveCount(0);
  // Everything: allowed, and the page says what the business receives.
  await money.getByRole('button', { name: 'Everything' }).click();
  await expect(money.getByTestId('business-you-receive')).toHaveText(
    'Transfer fee: ₦50, charged by our payment partner. It comes off the amount: the business receives ₦1,750. If the fee is different, the difference is settled on the business’s balance.',
  );
  const send = money.getByRole('button', { name: 'Withdraw ₦1,800' });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    money.getByRole('alert').filter({
      hasText:
        'The amount must be more than the ₦50 transfer fee, which comes off it.',
    }),
  ).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  // ₦50 left: not more than the fee, so it can't be withdrawn, and the page says why.
  held = '5000';
  await page.reload();
  await expect(money.getByTestId('business-balance')).toHaveText('₦50');
  await expect(money).toContainText(
    'The business’s ₦50 isn’t more than the ₦50 transfer fee, so it can’t be withdrawn yet. It stays in the business’s balance.',
  );
  await expect(money.getByRole('button', { name: 'Everything' })).toHaveCount(
    0,
  );
  await expect(money.getByLabel('Amount (NGN)')).toBeDisabled();
  await expect(page.locator('body')).not.toContainText(/bachs|TipMe pays/i);
  await expectAccessible(page);
});

test('a supporter is told the split before paying, at 360px, and the share is fixed on the tip', async ({
  page,
  browser,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({ owner: userId });
  const { memberId } = await seedMember({
    locationId: business.locations[0]!.id,
    profileId,
    shownName: 'Kemi',
    onShift: true,
  });
  const { agreementId } = await seedAgreement({
    memberId,
    proposedByUser: userId,
    businessBps: 2000,
  });
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
  });
  const supporter = await context.newPage();
  await supporter.goto(
    `/b/${business.slug}/${business.locations[0]!.slug}/${who.handle}`,
  );
  const panel = supporter.locator('[data-tip-panel]');
  await expect(panel.getByTestId('tip-share')).toHaveText(
    'Of what Kemi receives, they keep 80% and 20% goes to The Yellow Chilli.',
  );
  await expectAccessible(supporter);
  expect(await fitsViewport(supporter)).toBe(true);
  await startTip(supporter);
  await supporter.waitForURL(/\/mock-checkout\//);
  await supporter.getByRole('button', { name: /^Pay/ }).click();
  await supporter.waitForURL(/\/tip\/[0-9a-f-]{36}/);
  const tipId = new URL(supporter.url()).pathname.split('/')[2] ?? '';
  const [fixed] = await sql<{ agreement_id: string; business_bps: number }>(
    'SELECT agreement_id, business_bps FROM tip_business_shares WHERE tip_id = $1',
    [tipId],
  );
  expect(fixed).toEqual({ agreement_id: agreementId, business_bps: 2000 });
  await context.close();
});
