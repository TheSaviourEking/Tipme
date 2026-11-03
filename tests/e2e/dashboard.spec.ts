import { expect, test } from '@playwright/test';
import { UNBROKEN_NAME } from './profile-fixtures';
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

test('a brief 503 retries quietly and a lasting one says so', async ({
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

test('the balance comes first, with what is still being confirmed under it', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/dashboard', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        data: {
          ...body.data,
          availableMinor: '4860000',
          confirmingMinor: '180000',
        },
      },
    });
  });
  await page.route('**/v1/me/activity', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        data: [
          {
            kind: 'tip',
            id: '11111111-1111-4111-8111-111111111111',
            at: new Date().toISOString(),
            amountMinor: '180000',
            state: 'confirming',
            supporterLabel: 'Amaka',
          },
          ...body.data,
        ],
      },
    });
  });
  await page.goto('/dashboard');
  const main = page.locator('main');
  await expect(main.getByRole('heading').first()).toHaveText(
    'Ready to withdraw',
  );
  await expect(page.getByTestId('balance')).toHaveText('NGN 48,600.00');
  await expect(
    main.getByText('NGN 1,800.00 still being confirmed'),
  ).toBeVisible();
  // Pending money is never counted as available.
  await expect(page.getByTestId('balance')).not.toContainText('50,400');
  await expectAccessible(page);
});

test('before the first tip, a checklist instead of empty numbers', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard');
  await expect(
    page.getByRole('heading', { name: 'Get your page ready to share' }),
  ).toBeVisible();
  await expect(page.locator('.recipient-setup__steps > li')).toHaveCount(4);
  await expect(page.getByText('Today', { exact: true })).toHaveCount(0);
  await expect(page.getByText('This week', { exact: true })).toHaveCount(0);
  await expect(page.getByText('still being confirmed')).toHaveCount(0);
  await expectAccessible(page);
});

test('on a phone the dashboard has a tab bar of four @mobile', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard');
  const bar = page.getByRole('navigation', { name: 'Dashboard' });
  await expect(bar).toBeVisible();
  const links = bar.getByRole('link');
  await expect(links).toHaveText(['Home', 'Tips', 'My page', /^Settings/]);
  await expect(links.nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(bar.locator('[aria-current="page"]')).toHaveCount(1);
  for (const link of await links.all()) {
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  // It stays in view while the page scrolls.
  const viewport = page.viewportSize()!;
  await page.evaluate(() => {
    document.body.style.minHeight = '3000px';
    window.scrollTo(0, 1500);
  });
  const box = await bar.boundingBox();
  expect(box!.y + box!.height).toBeCloseTo(viewport.height, 0);
  expect(await fitsViewport(page)).toBe(true);
  await page.goto('/dashboard/tips');
  await expect(bar.locator('[aria-current="page"]')).toHaveText('Tips');
  await expect(
    bar.getByRole('link', { name: 'My page', exact: true }),
  ).toHaveAttribute('href', /\/@/);
});

test('a long unbroken name fits at 320px', async ({ page }, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/profile', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { data: { ...body.data, displayName: UNBROKEN_NAME } },
    });
  });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/dashboard');
  await expect(page.getByText(UNBROKEN_NAME).first()).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
});
