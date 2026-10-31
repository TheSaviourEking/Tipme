import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { enrolOwner } from './ops-helpers';

// Free and Pro (PR-012): staff make a page Pro, the recipient chooses their own amounts and
// minimum, and supporters see the exact amount they will pay.

test('staff make a page Pro, the recipient chooses amounts, and supporters see them', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await expect(
    page.getByText(
      /Choosing your own amounts and minimum is part of TipMe Pro/,
    ),
  ).toBeVisible();

  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await staff.getByRole('link', { name: 'Pages' }).click();
  await staff.getByLabel('Handle').fill(handle);
  await staff.getByRole('button', { name: 'Find page' }).click();
  await staff.getByRole('button', { name: 'Make Pro…' }).click();
  await staff
    .getByLabel('Why is this page getting Pro?')
    .fill('Pilot recipient for Pro amounts');
  await staff.getByRole('button', { name: 'Make Pro', exact: true }).click();
  await expect(staff.getByText(`@${handle} is now Pro`)).toBeVisible();
  await expectAccessible(staff);

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Tip amounts (Pro)' }),
  ).toBeVisible();
  // A preset below the smallest tip: the error is on the amounts, not the minimum.
  await page.getByLabel('Amount 1', { exact: true }).fill('1500');
  await page.getByLabel('Smallest tip (NGN)').fill('2000');
  await page.getByRole('button', { name: 'Save tip amounts' }).click();
  await expect(page.getByLabel('Amount 1', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.getByText(/each at least your smallest tip/)).toBeVisible();
  await page.getByLabel('Amount 1', { exact: true }).fill('2000');
  await page.getByLabel('Amount 2 (optional)').fill('5,000');
  await page.getByLabel('Amount 3 (optional)').fill('10000');
  await page.getByLabel('Smallest tip (NGN)').fill('2000');
  await page.getByRole('button', { name: 'Save tip amounts' }).click();
  await expect(
    page.getByText('Saved. Your page now shows these amounts.'),
  ).toBeVisible();
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(
      visitor.getByRole('radio', { name: '10,000 NGN' }),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(visitor.getByRole('radio', { name: '1,000 NGN' })).toHaveCount(
    0,
  );
  await visitor.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(visitor.getByText('You pay NGN 2,000.00')).toBeVisible();
  await expect(visitor.locator('.tip-breakdown')).toHaveCount(0);
  await visitor.getByRole('radio', { name: 'Other amount' }).check();
  await visitor.getByLabel('Your amount (NGN)').fill('1500');
  await visitor.getByRole('button', { name: /^Tip/ }).click();
  await expect(
    visitor.getByText(/Enter an amount of NGN 2,000 or more/),
  ).toBeVisible();
  await expectAccessible(visitor);
});
