import { expect, test, type Route } from '@playwright/test';
import { expectAccessible } from './helpers';
import { enrolOwner } from './ops-helpers';

// Business Pro, plan Task A5 (board BusinessPro section 4): the admin "Prices" screen, Personal Pro
// and Business Pro side by side, each changed on its own. The e2e stack runs with
// BUSINESS_PRO_ENABLED off (on, it would put staff and location limits on every other business
// spec), so the second test answers /v1/ops/business-pro-price itself, in the server's shapes.
// tests/integration/pro-price.test.mjs proves the real route and its serious action with the flag
// on. Nothing here changes a real price, so nothing needs putting back.

const LAUNCH = {
  id: '00000000-0000-4000-8000-000000700000',
  amountMinor: '700000',
  currency: 'NGN',
  effectiveFrom: '2026-11-14T08:00:00.000Z',
  setBy: null,
  approvedBy: null,
  reason: 'Launch price (owner’s decision, 14 Nov 2026)',
  createdAt: '2026-11-14T08:00:00.000Z',
  plan: 'business',
};
const REASON = 'January review: statements and analytics now shipped.';

test('with Business Pro off, Prices shows the Personal Pro card only', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.goto('/ops/pro-price');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { name: 'Prices', level: 1 }),
  ).toBeVisible();
  const personal = main.getByRole('region', { name: 'Personal Pro price' });
  await expect(personal.getByTestId('pro-price-live')).toHaveText(
    /₦[\d,]+ a month/,
  );
  await expect(
    main.getByRole('region', { name: 'Business Pro price' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Prices' }),
  ).toBeVisible();
});

test('Prices shows Personal Pro and Business Pro side by side; asking for a business change waits in its own card', async ({
  page,
}, testInfo) => {
  let waiting: string | null = null;
  let asked: unknown = null;
  await page.route('**/v1/ops/business-pro-price', async (route: Route) => {
    if (route.request().method() === 'POST') {
      asked = route.request().postDataJSON();
      waiting = 'a3f1c2d4-0000-4000-8000-000000000001';
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ data: { requestId: waiting } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          current: LAUNCH,
          history: [LAUNCH],
          limits: { minMinor: '10000', maxMinor: '100000000' },
          waitingRequestId: waiting,
        },
      }),
    });
  });
  await enrolOwner(page, testInfo);
  await page.goto('/ops/pro-price');
  const main = page.getByRole('main');
  const personal = main.getByRole('region', { name: 'Personal Pro price' });
  const business = main.getByRole('region', { name: 'Business Pro price' });
  await expect(
    personal.getByRole('heading', { name: 'Personal Pro' }),
  ).toBeVisible();
  await expect(
    business.getByRole('heading', { name: 'Business Pro' }),
  ).toBeVisible();
  await expect(business.getByTestId('business-pro-price-live')).toHaveText(
    '₦7,000 a month',
  );
  await expect(
    main.getByText(
      'New price applies to the next renewal; the shown price is honoured.',
    ),
  ).toBeVisible();
  // One history, each row labelled by its plan.
  const history = main.getByRole('list', { name: 'History' });
  await expect(
    history.getByRole('listitem').filter({ hasText: 'Business Pro' }),
  ).toContainText('₦7,000 a month');
  await expect(
    history.getByRole('listitem').filter({ hasText: 'Personal Pro' }).first(),
  ).toBeVisible();
  await expectAccessible(page);

  await business.getByRole('button', { name: '₦500 more' }).click();
  await expect(business.getByTestId('business-pro-price-new')).toHaveText(
    '₦7,500',
  );
  await business.getByLabel('Reason for this change').fill(REASON);
  await business.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    business.getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible();
  expect(asked).toEqual({ amountMinor: '750000', reason: REASON });
  // The personal card is untouched, and the business price hasn't changed yet.
  await expect(
    personal.getByText('Waiting for a second person', { exact: true }),
  ).toHaveCount(0);
  await expect(business.getByTestId('business-pro-price-live')).toHaveText(
    '₦7,000 a month',
  );
  await page.reload();
  await expect(
    main
      .getByRole('region', { name: 'Business Pro price' })
      .getByText('The price hasn’t changed yet.', { exact: false }),
  ).toBeVisible();

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(
    main.getByRole('heading', { name: 'Prices', level: 1 }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
