import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { enrolOwner, noOtherStaff, makePagePro } from './ops-helpers';
import { API_ORIGIN } from './stack';

// Staff-set pricing (ADR-0014): nothing changes a page's fee except staff, with a reason, and
// the resulting quote remains financially correct without exposing the recipient's fee details.

test('@alone staff set one page’s fee and grant a fee-free tip; each quote remains correct', async ({
  page,
  browser,
}, testInfo) => {
  await noOtherStaff();
  const { handle } = await signUpRecipient(page, testInfo);

  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await staff.getByRole('link', { name: 'Pages' }).click();
  await staff.getByLabel('Handle').fill(handle);
  await staff.getByRole('button', { name: 'Find page' }).click();
  await expect(staff.getByRole('heading', { name: 'Pricing' })).toBeVisible();
  await expect(staff.getByText('Free’s 7%, the plan’s rate')).toBeVisible();

  // A deal only counts below the plan's rate (Free 7%, owner 12 Nov 2026).
  await staff.getByLabel('New TipMe fee (%)').fill('6');
  // Other cards on the page have reason fields too, so each is found by its own form.
  const formOf = (label: string) =>
    staff.locator('form').filter({ has: staff.getByLabel(label) });
  await formOf('New TipMe fee (%)')
    .getByLabel('Reason')
    .fill('Launch partner with a reduced fee');
  await staff.getByRole('button', { name: 'Set this page’s fee' }).click();
  await expect(
    staff.getByText('The fee is now 6% for new tips.'),
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
      await expect(
        visitor.getByRole('radio', { name: '2,000 NGN' }),
      ).toBeVisible({ timeout: 2000 });
      const quote = await (
        await visitor.request.post(`${API_ORIGIN}/v1/tip-quotes`, {
          data: { handle, amountMinor: '200000', currency: 'NGN' },
        })
      ).json();
      expect(quote.data).toMatchObject({
        platformFeeMinor,
        providerFeeMinor,
        recipientNetMinor,
        payerTotalMinor: '200000',
        feeFree,
      });
    }).toPass({ timeout: 15_000 });
  // 6% of ₦2,000 is TipMe's ₦120 share, processing included: ₦90 fee plus the ₦30
  // processing estimate (1.5%). The recipient receives ₦1,880.
  await quoteFor({
    platformFeeMinor: '9000',
    providerFeeMinor: '3000',
    recipientNetMinor: '188000',
    feeFree: false,
  });

  await staff.getByLabel('Fee-free tips to grant').fill('1');
  await formOf('Fee-free tips to grant')
    .getByLabel('Reason')
    .fill('Apology for the outage');
  await staff.getByRole('button', { name: 'Grant fee-free tips' }).click();
  await expect(staff.getByText('1 fee-free tip granted.')).toBeVisible();
  await quoteFor({
    platformFeeMinor: '0',
    providerFeeMinor: '0',
    recipientNetMinor: '200000',
    feeFree: true,
  });
});

// Settings explains Free and Pro in one place (#pro): what Pro includes, and the price the server
// sends (₦5,000 a month, the owner's pricing of 12 Nov 2026; the e2e API has billing on).
test('the Pro explanation lists QR designs, three handle changes and no footer link, with the server’s price', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const pro = page.locator('#pro');
  await expect(pro.getByRole('heading', { name: 'TipMe Pro' })).toBeVisible();
  await expect(pro).toContainText('Your page is on the Free plan.');
  await expect(pro).toContainText('Pro QR designs');
  await expect(pro).toContainText('Three changes to your handle');
  await expect(pro).toContainText(
    'No “Get your own TipMe page” link at the foot of your page',
  );
  await expect(pro).toContainText('Photos and designs are free on every plan');
  await expect(pro).toContainText('₦5,000 a month');
  await expect(
    pro.getByRole('button', { name: 'Get Pro · ₦5,000 a month' }),
  ).toBeVisible();
  await expect(pro).not.toContainText(/NGN|\$|£|€|upgrade/i);

  await makePagePro(browser, handle, testInfo);
  await page.reload();
  await expect(pro).toContainText(
    'Your page is on TipMe Pro, turned on by the TipMe team.',
  );
  await expect(pro).not.toContainText(/NGN|\$|£|€|upgrade/i);
  await expectAccessible(page);
});
