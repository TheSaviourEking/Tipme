import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import { enrolOwner } from './ops-helpers';

/** The newest test email's link, from the pretend inbox (reloading until it arrives). */
async function testEmailLink(page: import('@playwright/test').Page) {
  const inbox = await page.context().newPage();
  const mail = inbox
    .getByRole('article')
    .filter({ hasText: 'TipMe mail test' })
    .first();
  await expect(async () => {
    await inbox.goto('/dev/inbox');
    await expect(mail).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 25_000 });
  const text = (await mail.textContent()) ?? '';
  await inbox.close();
  return /(\/ops\/providers\/confirm\S*#t=[\w-]+)/.exec(text)?.[1] ?? '';
}

test('staff send a test, confirm it from the inbox, and make the provider active', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.goto('/ops/providers');
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  const card = page.getByTestId('provider-mock');
  // Nothing confirmed yet (each run uses a fresh test, so look for the explanation).
  await card.getByLabel('Send the test to').fill('staff@example.com');
  await card.getByRole('button', { name: 'Send test' }).click();
  await card
    .getByLabel('Why are you testing this provider?')
    .fill('Checking mail before launch');
  await card.getByRole('button', { name: 'Send the test email' }).click();
  await expect(card.getByText(/Test sent to s•••@example\.com/)).toBeVisible();

  const link = await testEmailLink(page);
  await page.goto(link);
  await expect(page.getByText(/Test confirmed/)).toBeVisible();
  await expectAccessible(page);

  await page.goto('/ops/providers');
  const ready = page.getByTestId('provider-mock');
  await expect(ready.getByText(/Confirmed/)).toBeVisible();
  await ready.getByRole('button', { name: 'Make active' }).click();
  await ready
    .getByLabel('Why are you switching?')
    .fill('Confirmed by test, using it now');
  await ready.getByRole('button', { name: 'Switch provider' }).click();
  await expect(ready.getByText('Active', { exact: true })).toBeVisible();
});

test('an override can be set and removed with a reason', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.goto('/ops/providers');
  await page.getByLabel('Account (handle or user id)').fill('tobi');
  await page
    .getByLabel('Why does this account need its own provider?')
    .fill('Their mailbox rejects the main provider');
  await page.getByRole('button', { name: 'Pin account' }).click();
  const row = page.getByTestId('override-tobi');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Remove' }).click();
  await row.getByLabel('Why remove this pin?').fill('No longer needed here');
  await row.getByRole('button', { name: 'Remove pin' }).click();
  await expect(row).toHaveCount(0);
});
