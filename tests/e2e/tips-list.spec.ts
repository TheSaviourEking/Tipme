import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';

test('the tips header says what was received and from how many tips', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await tipAsVisitor(browser, handle, { name: 'Bo' });
  await page.goto('/dashboard/tips');
  // Two ₦2,000 tips, each ₦1,800 to the recipient: the API's total, formatted and nothing more.
  await expect(page.getByText('₦3,600 from 2 tips so far')).toBeVisible();
});

test('a tip still being confirmed is not in the totals', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/tip-totals', (route) =>
    route.fulfill({
      json: {
        data: { currency: 'NGN', receivedNetMinor: '0', paidTipCount: 0 },
      },
    }),
  );
  await page.goto('/dashboard/tips');
  await expect(page.getByRole('heading', { name: 'Your tips' })).toBeVisible();
  await expect(page.getByText(/so far/)).toHaveCount(0);

  // A paid tip makes the real totals. A tip still being confirmed then appears in the list (a real
  // one settles within seconds, so the list is faked): the header comes from the API alone, so it
  // does not move. Integration tests cover the SQL excluding confirming tips.
  await page.unroute('**/v1/me/tip-totals');
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await page.route('**/v1/me/tips?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        data: {
          ...body.data,
          items: [
            {
              tipId: '11111111-1111-4111-8111-111111111111',
              at: new Date().toISOString(),
              supporterLabel: 'Slow Sam',
              hasMessage: false,
              grossMinor: '5000000',
              netMinor: '4500000',
              state: 'confirming',
            },
            ...body.data.items,
          ],
        },
      },
    });
  });
  await page.reload();
  await expect(page.getByText('Slow Sam')).toBeVisible();
  await expect(page.getByText('₦1,800 from 1 tip so far')).toBeVisible();
});

test('With a note lists only tips with a note', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thank you' });
  await tipAsVisitor(browser, handle, { name: 'Bo' });
  await page.goto('/dashboard/tips');
  const filters = page.getByRole('group', { name: 'Show' });
  await expect(filters.getByRole('button')).toHaveText([
    'All',
    'With a note',
    'Being confirmed',
  ]);
  await expect(page.getByRole('link', { name: /Tip from/ })).toHaveCount(2);
  await filters.getByRole('button', { name: 'With a note' }).click();
  const rows = page.getByRole('link', { name: /Tip from/ });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Ada M.');
  await expect(rows).toContainText('with a note');
  await expectAccessible(page);
});

test('the totals keep showing when a refresh fails', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await page.goto('/dashboard/tips');
  const subtitle = page.getByText('₦1,800 from 1 tip so far');
  await expect(subtitle).toBeVisible();
  await page.route('**/v1/me/tip-totals', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'x' } },
    }),
  );
  // Choosing a filter reads the totals again; the answer fails and the last figures stay.
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes('/v1/me/tip-totals') && response.status() === 503,
  );
  await page
    .getByRole('group', { name: 'Show' })
    .getByRole('button', { name: 'With a note' })
    .click();
  await refreshed;
  await expect(subtitle).toBeVisible();
});
