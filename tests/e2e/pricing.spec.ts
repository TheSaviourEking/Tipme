import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { enrolOwner } from './ops-helpers';

// Staff-set pricing (ADR-0014): nothing changes a page's fee except staff, with a reason, and
// supporters see the result before paying.

test('staff set one page’s fee and grant a fee-free tip; supporters see each before paying', async ({
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
  const receives = async (text: string) =>
    expect(async () => {
      await visitor.goto(`/@${handle}`);
      await visitor.getByRole('radio', { name: '2,000 NGN' }).check();
      await expect(visitor.getByText(text)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15_000 });
  // 8% of ₦2,000 (processing included) leaves ₦1,840.
  await receives(`receives NGN 1,840.00 after fees`);

  await staff.getByLabel('Fee-free tips to grant').fill('1');
  await staff.getByLabel('Reason').nth(1).fill('Apology for the outage');
  await staff.getByRole('button', { name: 'Grant fee-free tips' }).click();
  await expect(staff.getByText('1 fee-free tip granted.')).toBeVisible();
  await receives(`receives NGN 2,000.00 after fees`);
});
