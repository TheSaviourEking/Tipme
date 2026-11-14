import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';

// The payment account card's Country choice (owner's ask, 14 Nov 2026): our payment partner's payout
// countries, Nigeria first and preselected. This stack runs the pretend provider, which has no
// payment account card, so the card's own requests are answered here; nothing reaches the partner.

const HINT = 'TipMe pays out in naira to Nigerian bank accounts for now.';

type Sent = { country?: string; entityType?: string };

/** Answers the card as a sandbox account not yet set up; records what setup sends. */
async function fakePaymentAccount(page: Page) {
  const sent: Sent[] = [];
  let status: string | null = null;
  await page.route('**/v1/me/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/me/events') return route.fulfill({ status: 204 });
    if (path === '/v1/me/payment-account' && request.method() === 'GET')
      return route.fulfill({
        json: {
          data: {
            enabled: true,
            environment: 'sandbox',
            status,
            chargesEnabled: status === 'ACTIVE',
            payoutsEnabled: false,
            feeCollector: null,
            requirementsDue: [],
            lastSyncedAt: null,
          },
        },
      });
    if (path === '/v1/me/payment-account/onboarding') {
      sent.push(JSON.parse(request.postData() ?? '{}') as Sent);
      status = 'ACTIVE';
      return route.fulfill({
        json: { data: { status: 'ACTIVE', chargesEnabled: true } },
      });
    }
    return route.fallback();
  });
  return sent;
}

const card = (page: Page) => page.locator('#payments');

test('Country: Nigeria preselected; choosing Ghana shows the hint and sends GH', async ({
  page,
}, testInfo) => {
  const sent = await fakePaymentAccount(page);
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#payments');
  const country = card(page).getByLabel('Country', { exact: true });
  await expect(country).toBeVisible();
  await expect(country).toHaveValue('NG');
  await expect(country.locator('option:checked')).toHaveText('Nigeria — NG');
  const options = await country.locator('option').allTextContents();
  expect(options).toHaveLength(28);
  expect(options[0]).toBe('Nigeria — NG');
  expect(options).toContain('Ghana — GH');
  // The old free-text field and its two-letter rule are gone.
  await expect(card(page).getByLabel('Country code')).toHaveCount(0);
  await expect(card(page).getByText(HINT)).toHaveCount(0);

  await country.selectOption('GH');
  await expect(card(page).getByText(HINT)).toBeVisible();
  await expect(country).toHaveAccessibleDescription(HINT);
  await expectAccessible(page);

  await card(page)
    .getByRole('button', { name: 'Set up test payments' })
    .click();
  await expect(
    card(page).getByRole('status').getByText('Ready to receive test tips'),
  ).toBeVisible();
  expect(sent).toEqual([{ country: 'GH', entityType: 'individual' }]);
});

test('Country works by keyboard: type to choose, Tab on, Enter sends', async ({
  page,
}, testInfo) => {
  const sent = await fakePaymentAccount(page);
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#payments');
  const country = card(page).getByLabel('Country', { exact: true });
  await expect(country).toHaveValue('NG');
  await country.focus();
  await expect(country).toBeFocused();
  // Typing a name chooses it without opening the list (arrow keys open it on a Mac).
  await page.keyboard.type('Ghana');
  await expect(country).toHaveValue('GH');
  await expect(card(page).getByText(HINT)).toBeVisible();

  // Tab reaches the next field, then the button, which Enter submits.
  await page.keyboard.press('Tab');
  await expect(card(page).getByLabel('Account type')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    card(page).getByRole('button', { name: 'Set up test payments' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    card(page).getByRole('status').getByText('Ready to receive test tips'),
  ).toBeVisible();
  expect(sent).toEqual([{ country: 'GH', entityType: 'individual' }]);
});

for (const width of [320, 1280]) {
  test(`Country fits at ${width}px with the hint showing`, async ({
    page,
  }, testInfo) => {
    await fakePaymentAccount(page);
    await signUpRecipient(page, testInfo, { live: false });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard/settings#payments');
    const country = card(page).getByLabel('Country', { exact: true });
    await country.selectOption('GB');
    await expect(card(page).getByText(HINT)).toBeVisible();
    const fits = await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    );
    expect(fits).toBe(true);
    const box = await country.boundingBox();
    const cardBox = await card(page).boundingBox();
    expect(box && cardBox).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(cardBox!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      cardBox!.x + cardBox!.width + 0.5,
    );
  });
}
