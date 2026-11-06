import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { enrolOwner } from './ops-helpers';

const REASON = 'The owner rang: someone else took over this account.';

test('staff freeze a reported takeover from Pages, the card remembers it, and release asks for the checks', async ({
  page,
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const recipient = await context.newPage();
  const { handle } = await signUpRecipient(recipient, {
    ...testInfo,
    workerIndex: testInfo.workerIndex + 1000,
  } as typeof testInfo);
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByRole('button', { name: 'Freeze withdrawals…' }).click();
  await page.getByLabel('Who reported it, and what did they say?').fill(REASON);
  await page.getByRole('button', { name: 'Freeze withdrawals' }).click();
  await expect(page.getByText('Withdrawals are frozen')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'End all sessions…' }),
  ).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  // The recipient sees only the usual pause, and not why.
  await recipient.goto('/dashboard/withdraw');
  await expect(
    recipient.getByText(/Withdrawals are paused while support checks/),
  ).toBeVisible();
  await expect(recipient.getByText(/takeover/i)).toHaveCount(0);

  // It survives a reload, which the card used to forget.
  await page.reload();
  await expect(page.getByText('Withdrawals are frozen')).toBeVisible();

  // Signing them out works from here.
  await page.getByRole('button', { name: 'End all sessions…' }).click();
  await page.getByLabel('Why sign this account out everywhere?').fill(REASON);
  await page.getByRole('button', { name: 'End all sessions' }).click();
  await expect(page.getByText('Signed out everywhere')).toBeVisible();

  // Release warns, and needs the written check.
  await page.getByRole('link', { name: 'the issue' }).click();
  await page.getByRole('button', { name: 'Resolve…' }).click();
  await expect(page.getByText('This releases the freeze')).toBeVisible();
  await page.getByLabel('How was it settled?').selectOption('account_secured');
  await page
    .getByLabel(
      'I checked the current bank and the sign-in with the real owner.',
    )
    .check();
  await page.getByLabel('How was it resolved?').fill(REASON);
  await page.getByRole('button', { name: 'Resolve issue' }).click();
  await expect(
    page.getByText('The issue is resolved. Withdrawals are released.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resolve issue' })).toHaveCount(
    0,
  );
  await context.close();
});

// The switch is global and specs run side by side, so the change itself is answered at the API
// boundary here; tests/integration/withdrawals-switch-api.test.mjs changes it for real.
test('the Overview shows live state and the withdrawals switch, and asks why before changing it', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.route('**/v1/ops/withdrawals-switch', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { data: { changed: true } } })
      : route.fallback(),
  );
  await page.goto('/ops');
  await expect(page.getByTestId('live-now')).toHaveText(
    'Live payments: off. Test money only.',
  );
  const control = page.getByTestId('withdrawals-switch');
  await expect(control.getByText('Withdrawals: on.')).toBeVisible();
  await control
    .getByRole('button', { name: 'Switch off all withdrawals…' })
    .click();
  await control.getByLabel('Why stop all withdrawals?').fill(REASON);
  await control.getByRole('button', { name: 'Switch off' }).click();
  await expect(
    control.getByText('Withdrawals are OFF for everyone'),
  ).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);
});

test('with withdrawals switched off the Withdraw page says so plainly, before any amount', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/withdrawal-quote', (route) =>
    route.fulfill({
      json: {
        data: { inReview: false, state: 'paused', reason: 'switched_off' },
      },
    }),
  );
  await page.goto('/dashboard/withdraw');
  // A standing warning, before any amount; the instrument says it in two words.
  await expect(page.locator('.tm-warning')).toContainText(
    'Withdrawals are paused for now. Your balance is safe.',
  );
  await expect(page.locator('.withdraw__meter')).toContainText(
    'Paused for now',
  );
  await expect(page.getByLabel(/amount/i)).toHaveCount(0);
  await expectAccessible(page);
});
