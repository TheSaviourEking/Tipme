import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';

/** The newest pretend email whose text matches, read from the pretend inbox (waits for it). */
async function readMail(page: Page, pattern: RegExp): Promise<string> {
  const inbox = await page.context().newPage();
  const mail = inbox.getByRole('article').filter({ hasText: pattern }).first();
  // Mail written by the worker can arrive a few seconds later: reload until it is there.
  await expect(async () => {
    await inbox.goto('/dev/inbox');
    await expect(mail).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 25_000 });
  const text = (await mail.textContent()) ?? '';
  await inbox.close();
  return text;
}

test('a recipient is told about a confirmed tip, verifies an email and is emailed the next tip', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  // Notifications that already exist when the page opens count as seen, so wait for the first
  // poll before tipping: only a tip that arrives afterwards pops up.
  const firstPoll = page.waitForResponse((response) =>
    response.url().includes('/v1/me/notifications'),
  );
  await page.goto('/dashboard');
  await firstPoll;
  await expect(
    page.getByRole('button', { name: 'Notifications, none unread' }),
  ).toBeVisible();

  await tipAsVisitor(browser, handle, { name: 'Bola' });
  await expect(
    page.getByRole('status').filter({ hasText: 'You got a tip' }),
  ).toBeVisible({ timeout: 25_000 });
  // The first tip is also a moment ("Your first tip!"), which the worker adds just after.
  await expect(
    page.getByRole('button', { name: 'Notifications, 2 unread' }),
  ).toBeVisible({ timeout: 25_000 });
  await page.getByRole('button', { name: 'Notifications, 2 unread' }).click();
  // The toast may still be showing the same words: look in the panel.
  const panel = page.locator('#notification-list');
  await expect(panel.getByText('NGN 1,800.00 from Bola')).toBeVisible();
  await expect(
    panel.getByText('Your first tip! Someone noticed your work.'),
  ).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Notifications, none unread' }),
  ).toBeVisible();

  // A domain unique to this test: the pretend inbox shows only the first letter and the domain.
  const domain = `${handle.replace('_', '-')}.example`;
  const email = `kemi@${domain}`;
  await page.goto('/dashboard/settings');
  await page.getByLabel('New email address').fill(email);
  await page.getByRole('button', { name: 'Send code to new address' }).click();
  await expect(page.getByText(/We sent a code to/)).toBeVisible();
  const mail = await readMail(
    page,
    new RegExp(`k•••@${domain}.*Confirm your new TipMe email`, 's'),
  );
  const code = /\b(\d{6})\b/.exec(mail)?.[1] ?? '';
  await page.getByLabel('Code sent to the new address').fill(code);
  await page.getByRole('button', { name: 'Change email' }).click();
  await expect(page.getByText(/Your email was changed/)).toBeVisible();

  await tipAsVisitor(browser, handle, { name: 'Chidi' });
  await readMail(
    page,
    new RegExp(`k•••@${domain}.*You got a ₦1,800 tip on TipMe.*Chidi`, 's'),
  );
});
