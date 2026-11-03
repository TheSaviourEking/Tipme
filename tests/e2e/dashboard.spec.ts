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
    page.getByRole('heading', { name: 'Get your page ready to share' }),
  ).toBeVisible();
  await expectAccessible(page);

  await tipAsVisitor(browser, handle, {
    name: 'Ada M.',
    message: 'Lovely braids, thank you',
  });
  await page.reload();
  await expect(page.getByTestId('balance')).toHaveText('NGN 1,800.00');
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
  ).toContainText('NGN 1,800.00');
  await expect(
    page.getByText('Confirmed by the payment provider'),
  ).toBeVisible();
  await expect(page.getByText(/Reference ending …[0-9a-f-]{6}/)).toBeVisible();
  await expectAccessible(page);

  await page.goto('/dashboard/withdraw');
  await page.getByLabel('Amount (NGN)').fill('1800');
  await page.getByRole('button', { name: 'Withdraw NGN 1,800.00' }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();
  await expectAccessible(page);
  await page.goto('/dashboard');
  await expect(page.getByTestId('balance')).toHaveText('NGN 0.00');
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

test('a moment of 503 on the dashboard retries quietly; a lasting one shows the error', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  const busy = {
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({
      error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'x', reference: 'x' },
    }),
  };
  let asked = 0;
  await page.route('**/v1/me/dashboard', (route) =>
    ++asked === 1 ? route.fulfill(busy) : route.continue(),
  );
  await page.goto('/dashboard');
  await expect(page.getByTestId('balance')).toBeVisible();
  await expect(page.getByText('We couldn’t load your dashboard')).toHaveCount(
    0,
  );
  expect(asked).toBe(2);

  await page.unroute('**/v1/me/dashboard');
  await page.route('**/v1/me/dashboard', (route) => route.fulfill(busy));
  await page.reload();
  await expect(page.getByText('We couldn’t load your dashboard')).toBeVisible();
});
