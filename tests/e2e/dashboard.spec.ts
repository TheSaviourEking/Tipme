import { expect, test } from '@playwright/test';
import { UNBROKEN_NAME } from './profile-fixtures';
import { saveBank } from './ops-helpers';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';

test('a new recipient sees the first-day screen, then their tip and its proof', async ({
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
  await expect(page.getByTestId('balance')).toHaveText('₦1,800');
  const row = page.getByRole('link', { name: /Tip from Ada M\./ });
  await expect(row).toContainText('Paid');
  await expect(page.getByText('Today')).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  await row.click();
  await expect(
    page.getByRole('heading', { name: '₦1,800 from Ada M.' }),
  ).toBeVisible();
  await expect(page.getByText('Lovely braids, thank you')).toBeVisible();
  const receipt = page.locator('.receipt');
  await expect(
    receipt.locator('div', { hasText: 'Ada M. tipped' }),
  ).toContainText('₦2,000');
  await expect(
    receipt.locator('div', { hasText: 'You received' }),
  ).toContainText('₦1,800');
  await expect(receipt.getByText('In your balance')).toBeVisible();
  await expect(
    receipt.getByText(/Confirmed by our payment partner/),
  ).toBeVisible();
  await expect(receipt.getByText(/…[0-9a-f-]{6}/)).toBeVisible();
  await expectAccessible(page);
});

test('a recipient withdraws a tip and sees it sent, and the dashboard fits a narrow phone', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await page.goto('/dashboard');
  await expect(page.getByTestId('balance')).toHaveText('₦1,800', {
    timeout: 15_000,
  });

  // A withdrawal records the bank it went to, if one was saved.
  await saveBank(handle, 'GTBank', '6789');
  await page.goto('/dashboard/withdraw');
  await page.getByLabel('Amount (NGN)').fill('1800');
  await page.getByRole('button', { name: 'Withdraw ₦1,800' }).click();
  await expect(page.getByText('Withdrawal requested')).toBeVisible();
  await expectAccessible(page);
  await page.goto('/dashboard');
  await expect(page.getByTestId('balance')).toHaveText('₦0');
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/Withdrawal.*Sent/)).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 15_000 });
  await expect(
    page.locator('.activity-list__row').filter({ hasText: 'Withdrawal' }),
  ).toContainText(/to GTBank ••\d{4}/);

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

// The reply has arrived; give React one frame to paint it before asserting something is absent.
const rendered = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => setTimeout(done, 0)),
      ),
  );

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
  const quoted0 = page.waitForResponse('**/v1/me/withdrawal-quote');
  await page.goto('/dashboard');
  await quoted0;
  await rendered(page);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(
    'Your balance',
  );
  await expect(page.getByTestId('balance')).toHaveText('₦48,600');
  // The quote allows nothing on a page with no tips behind it, so none of the balance is called
  // ready to withdraw (the ledger figure is not what can go).
  await expect(page.getByText('Ready to withdraw')).toHaveCount(0);
  await expect(main.getByText('₦1,800 still being confirmed')).toBeVisible();
  // Pending money is never counted as available.
  await expect(page.getByTestId('balance')).not.toContainText('50,400');
  await expectAccessible(page);
});

test('Ready to withdraw is only what the withdrawal quote allows', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/dashboard', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { data: { ...body.data, availableMinor: '1000000' } },
    });
  });
  const quote = {
    inReview: false,
    ledgerMinor: '1000000',
    providerMinor: '500000',
    feeMinor: '5000',
    destination: { bankName: 'GTBank', last4: '1234' },
  };
  // Only part of the balance has reached the account: that part, not the ledger figure, is ready.
  await page.route('**/v1/me/withdrawal-quote', (route) =>
    route.fulfill({
      json: {
        data: { ...quote, state: 'ready', withdrawableMinor: '500000' },
      },
    }),
  );
  await page.goto('/dashboard');
  await expect(page.getByTestId('balance')).toHaveText('₦10,000');
  await expect(page.getByTestId('ready')).toHaveText(
    'Ready to withdraw ₦5,000',
  );
  // A quote that refuses: the balance stays, and nothing is called ready.
  await page.unroute('**/v1/me/withdrawal-quote');
  await page.route('**/v1/me/withdrawal-quote', (route) =>
    route.fulfill({
      json: { data: { ...quote, state: 'ready', withdrawableMinor: '0' } },
    }),
  );
  const quoted1 = page.waitForResponse('**/v1/me/withdrawal-quote');
  await page.reload();
  await quoted1;
  await rendered(page);
  await expect(page.getByTestId('balance')).toHaveText('₦10,000');
  await expect(page.getByText('Ready to withdraw')).toHaveCount(0);
  await page.unroute('**/v1/me/withdrawal-quote');
  await page.route('**/v1/me/withdrawal-quote', (route) =>
    route.fulfill({
      json: {
        data: { inReview: false, state: 'paused', reason: 'switched_off' },
      },
    }),
  );
  const quoted2 = page.waitForResponse('**/v1/me/withdrawal-quote');
  await page.reload();
  await quoted2;
  await rendered(page);
  await expect(page.getByTestId('balance')).toHaveText('₦10,000');
  await expect(page.getByText('Ready to withdraw')).toHaveCount(0);
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
