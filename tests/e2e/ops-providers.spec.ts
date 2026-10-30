import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import { enrolOwner, withDatabase } from './ops-helpers';

// Only the pretend provider is configured in e2e, and it is the default. Choosing a provider
// without keys here means no card is active, so the pretend one can be switched to.
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await withDatabase(async (db) => {
    const run = db as { execute(sql: string): Promise<unknown> };
    await run.execute('DELETE FROM provider_tests');
    await run.execute(
      `INSERT INTO provider_settings (kind, active_provider, changed_at, reason)
       VALUES ('mail', 'zeptomail', now(), 'e2e setup')
       ON CONFLICT (kind) DO UPDATE SET active_provider = 'zeptomail'`,
    );
  });
});
test.afterAll(async () => {
  await withDatabase(async (db) => {
    await (db as { execute(sql: string): Promise<unknown> }).execute(
      "DELETE FROM provider_settings WHERE kind = 'mail'",
    );
  });
});

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
  // Make active is unavailable until a test is confirmed.
  await expect(card.getByRole('button', { name: 'Make active' })).toHaveCount(
    0,
  );
  await card.getByRole('button', { name: 'Send test' }).click();
  await card.getByLabel('Send the test to').fill('staff@example.com');
  await card
    .getByLabel('Why are you testing this provider?')
    .fill('Checking mail before launch');
  await card.getByRole('button', { name: 'Send the test email' }).click();
  await expect(card.getByText(/Test sent to s•••@example\.com/)).toBeVisible();

  // A signed-out staff member opening the link comes back to it after signing in.
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
  await page.getByLabel('Provider', { exact: true }).selectOption('mock');
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
