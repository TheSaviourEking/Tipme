import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { enrolOwner } from './ops-helpers';

// Staff-set pricing (ADR-0014): nothing changes a page's fee except staff, with a reason, and
// the resulting quote remains financially correct without exposing the recipient's fee details.

test('staff set one page’s fee and grant a fee-free tip; each quote remains correct', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);

  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await staff.getByRole('link', { name: 'Pages' }).click();
  await staff.getByLabel('Handle').fill(handle);
  await staff.getByRole('button', { name: 'Find page' }).click();
  await expect(staff.getByRole('heading', { name: 'Pricing' })).toBeVisible();
  await expect(staff.getByText('(standard)')).toBeVisible();

  await staff.getByLabel('New TipMe fee (%)').fill('8');
  await staff
    .getByLabel('Reason')
    .first()
    .fill('Launch partner with a reduced fee');
  await staff.getByRole('button', { name: 'Set this page’s fee' }).click();
  await expect(
    staff.getByText('The fee is now 8% for new tips.'),
  ).toBeVisible();
  await expectAccessible(staff);

  const visitor = await (await browser.newContext()).newPage();
  const quoteFor = async ({
    platformFeeMinor,
    providerFeeMinor,
    recipientNetMinor,
    feeFree,
  }: {
    platformFeeMinor: string;
    providerFeeMinor: string;
    recipientNetMinor: string;
    feeFree: boolean;
  }) =>
    expect(async () => {
      await visitor.goto(`/@${handle}`);
      const quoteResponse = visitor.waitForResponse(
        (response) =>
          response.url().endsWith('/v1/tip-quotes') &&
          response.request().method() === 'POST',
      );
      await visitor.getByRole('radio', { name: '2,000 NGN' }).check();
      await expect(visitor.getByText('You pay NGN 2,000.00')).toBeVisible({
        timeout: 2000,
      });
      const quote = await (await quoteResponse).json();
      expect(quote.data).toMatchObject({
        platformFeeMinor,
        providerFeeMinor,
        recipientNetMinor,
        payerTotalMinor: '200000',
        feeFree,
      });
    }).toPass({ timeout: 15_000 });
  // 8% of ₦2,000 is TipMe's ₦160 share, processing included: ₦130 fee plus the ₦30
  // processing estimate (1.5%). The recipient receives ₦1,840.
  await quoteFor({
    platformFeeMinor: '13000',
    providerFeeMinor: '3000',
    recipientNetMinor: '184000',
    feeFree: false,
  });

  await staff.getByLabel('Fee-free tips to grant').fill('1');
  await staff.getByLabel('Reason').nth(1).fill('Apology for the outage');
  await staff.getByRole('button', { name: 'Grant fee-free tips' }).click();
  await expect(staff.getByText('1 fee-free tip granted.')).toBeVisible();
  await quoteFor({
    platformFeeMinor: '0',
    providerFeeMinor: '0',
    recipientNetMinor: '200000',
    feeFree: true,
  });
});
