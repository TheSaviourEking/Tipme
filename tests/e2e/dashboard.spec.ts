import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';

test('a new recipient sees the first-day screen, then their tip, its proof and a withdrawal', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard');
  await expect(
    page.getByText('Show your QR to get your first tip'),
  ).toBeVisible();
  await expectAccessible(page);

  await tipAsVisitor(browser, handle, {
    name: 'Ada M.',
    message: 'Lovely braids, thank you',
  });
  await page.reload();
  await expect(page.getByTestId('balance')).toHaveText('NGN 1,870.00');
  const row = page.getByRole('link', { name: /Tip from Ada M\./ });
  await expect(row).toContainText('Paid');
  await expect(page.getByText('Today')).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  await row.click();
  await expect(
    page.getByRole('heading', { name: 'Tip from Ada M.' }),
  ).toBeVisible();
  await expect(page.getByText('Lovely braids, thank you')).toBeVisible();
  const breakdown = page.locator('.tip-breakdown');
  await expect(
    breakdown.locator('div', { hasText: 'They tipped' }),
  ).toContainText('NGN 2,000.00');
  await expect(
    breakdown.locator('div', { hasText: 'You received' }),
  ).toContainText('NGN 1,870.00');
  await expect(
    page.getByText('Confirmed by the payment provider'),
  ).toBeVisible();
  await expect(page.getByText(/Reference ending …[0-9a-f-]{6}/)).toBeVisible();
  await expectAccessible(page);

  await page.goto('/dashboard/withdraw');
  await page.getByLabel('Amount (NGN)').fill('1000');
  await page.getByRole('button', { name: 'Withdraw NGN 1,000.00' }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();
  await expectAccessible(page);
  await page.goto('/dashboard');
  await expect(page.getByTestId('balance')).toHaveText('NGN 870.00');
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/Withdrawal.*Sent/)).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 15_000 });

  await page.goto('/dashboard/tips');
  await expect(
    page.getByRole('link', { name: /Tip from Ada M\./ }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.setViewportSize({ width: 320, height: 720 });
  for (const path of ['/dashboard', '/dashboard/tips', '/dashboard/withdraw']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await fitsViewport(page), path).toBe(true);
  }
});
