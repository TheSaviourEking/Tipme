import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
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

  // A ₦40,000 tip at the business. R2-C2 will fix the share at intent time; until then the test
  // writes the row itself, between the intent and the pretend payment.
  const quote = await (
    await request.post(`${API_ORIGIN}/v1/tip-quotes`, {
      data: { handle: who.handle, amountMinor: '4000000', currency: 'NGN' },
    })
  ).json();
  const intent = await (
    await request.post(`${API_ORIGIN}/v1/tip-intents`, {
      headers: { 'idempotency-key': randomUUID() },
      data: { quoteId: quote.data.quoteId, businessMemberId: memberId },
    })
  ).json();
  const share = (BigInt(quote.data.recipientNetMinor) * 5000n) / 10000n;
  await sql(
    `INSERT INTO tip_business_shares (tip_id, agreement_id, business_id, business_bps, share_minor)
     VALUES ($1, $2, $3, 5000, $4)`,
    [intent.data.tipId, agreementId, business.businessId, share.toString()],
  );
  const reference = String(intent.data.checkoutUrl).split('/mock-checkout/')[1];
  await request.post(`${API_ORIGIN}/v1/mock-provider/checkout/${reference}`, {
    data: { outcome: 'succeed' },
  });
  // As the web's formatNaira writes it: kobo only when there are some.
  const kobo = share % 100n;
  const shareText = `₦${new Intl.NumberFormat('en').format(share / 100n)}${kobo ? `.${String(kobo).padStart(2, '0')}` : ''}`;

  // The Business page draws its sections from the business's detail, which PR B1 serves. It is
  // not on this branch yet, so only that one read is answered here; all money calls are real.
  await page.route(
    `${API_ORIGIN}/v1/me/businesses/${business.businessId}`,
    (route) =>
      route.fulfill({
        json: {
          data: {
            id: business.businessId,
            slug: business.slug,
            name: 'The Yellow Chilli',
            status: 'verified',
            slugLocked: true,
            contact: { name: 'Funke', email: 'funke@example.com' },
            locations: [],
            you: { role: 'owner' },
          },
        },
      }),
  );

  const money = page.locator('#money');
  await expect(async () => {
    await page.goto('/dashboard/business');
    await expect(money.getByTestId('business-balance')).toHaveText(shareText, {
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });
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
  await expectAccessible(page);

  await money.getByRole('button', { name: 'Everything' }).click();
  await money.getByRole('button', { name: /^Withdraw ₦/ }).click();
  await expect(money.getByText('Withdrawal requested')).toBeVisible();
  await expect(money.getByTestId('business-balance')).toHaveText('₦0');
  const [payout] = await sql<{
    business_id: string;
    profile_id: string | null;
  }>('SELECT business_id, profile_id FROM payouts WHERE business_id = $1', [
    business.businessId,
  ]);
  expect(payout).toEqual({
    business_id: business.businessId,
    profile_id: null,
  });
  await expect(page.locator('body')).not.toContainText(/bachs/i);
  expect(await fitsViewport(page)).toBe(true);
});
