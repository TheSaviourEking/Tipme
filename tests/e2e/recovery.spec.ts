import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { enrolOwner } from './ops-helpers';

async function mailCode(page: Page, hint: string, subject: string) {
  const inbox = await page.context().newPage();
  const mail = inbox
    .getByRole('article')
    .filter({ hasText: hint })
    .filter({ hasText: subject })
    .first();
  await expect(async () => {
    await inbox.goto('/dev/inbox');
    await expect(mail).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 25_000 });
  const code = /\b(\d{6})\b/.exec((await mail.textContent()) ?? '')?.[1] ?? '';
  await inbox.close();
  return code;
}

// Letters around the digits: the code is the only 6-digit word in the inbox line.
const suffix = () => `x${Date.now() % 100000000}x`;

async function addRecovery(page: Page, address: string, hint: string) {
  await page.goto('/dashboard/settings');
  await page.getByLabel('Recovery email address').fill(address);
  await page
    .getByRole('button', { name: 'Send code to recovery email' })
    .click();
  await page
    .getByLabel('Code sent to your recovery email')
    .fill(await mailCode(page, hint, 'Confirm your TipMe recovery email'));
  await page.getByRole('button', { name: 'Confirm recovery email' }).click();
  await expect(page.getByText(/Recovery email: r•••@/)).toBeVisible();
}

test('a recipient is reminded, adds a recovery email and the reminder disappears', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard');
  const reminder = page
    .getByText('Add a recovery email', { exact: false })
    .first();
  await expect(reminder).toBeVisible();
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(
    page.locator('#notification-list').getByText(/recovery email/),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  const domain = `rec-${suffix()}.example`;
  await addRecovery(page, `r@${domain}`, `r•••@${domain}`);
  await expectAccessible(page);
  await page.goto('/dashboard');
  await expect(
    page
      .getByRole('region', { name: 'Needs your attention' })
      .getByText('Add a recovery email'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(
    page.locator('#notification-list').getByText(/recovery email/),
  ).toHaveCount(0);
});

test('someone without their email recovers, waits 24 hours, and can cancel from settings', async ({
  page,
  browser,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const id = suffix();
  const recovery = `rec-${id}.example`;
  await addRecovery(page, `r@${recovery}`, `r•••@${recovery}`);

  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto('/sign-in');
  await stranger
    .getByRole('link', { name: /Can’t get into your email/ })
    .click();
  await stranger.getByLabel('Your sign-in email').fill(who.email);
  await stranger.getByRole('button', { name: 'Send recovery code' }).click();
  await stranger
    .getByLabel('Code sent to your recovery email')
    .fill(
      await mailCode(stranger, `r•••@${recovery}`, 'Your TipMe recovery code'),
    );
  const newDomain = `new-${id}.example`;
  await stranger.getByLabel('New sign-in email').fill(`n@${newDomain}`);
  await stranger
    .getByRole('button', { name: 'Send code to new email' })
    .click();
  await stranger
    .getByLabel('Code sent to your new email')
    .fill(
      await mailCode(
        stranger,
        `n•••@${newDomain}`,
        'Confirm your new TipMe sign-in email',
      ),
    );
  await stranger.getByRole('button', { name: 'Move my account' }).click();
  await expect(stranger.getByText(/in 24 hours/)).toBeVisible();

  await page.goto('/dashboard/settings');
  await expect(page.getByText(/being moved to n•••@/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel the move' }).click();
  await expect(page.getByText(/being moved to n•••@/)).toHaveCount(0);
});

test('staff move a sign-in email with the checks recorded, and the person finishes it', async ({
  page,
  browser,
}, testInfo) => {
  const person = await (await browser.newContext()).newPage();
  const who = await signUpRecipient(person, testInfo, { live: false });
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/pages?handle=${who.handle}`);
  await page.getByRole('button', { name: 'Move sign-in email…' }).click();
  const domain = `staff-${suffix()}.example`;
  await page.getByLabel('New sign-in email').fill(`t@${domain}`);
  await page
    .getByLabel('What did you check to be sure who this is?')
    .fill('Matched their last three tips and ID');
  await page
    .getByLabel('Why is this account moving?')
    .fill('They lost access to their email');
  await page.getByRole('button', { name: 'Send code to new email' }).click();
  await expect(
    page.getByText(/code was sent to the new address/),
  ).toBeVisible();

  await person.goto('/recover');
  await person
    .getByRole('button', { name: 'Enter the code we sent to your new email' })
    .click();
  await person.getByLabel('Your old sign-in email').fill(who.email);
  await person.getByLabel('New sign-in email').fill(`t@${domain}`);
  await person
    .getByLabel('Code sent to your new email')
    .fill(
      await mailCode(
        person,
        `t•••@${domain}`,
        'Confirm your new TipMe sign-in email',
      ),
    );
  await person.getByRole('button', { name: 'Move my account' }).click();
  await expect(person.getByText(/in 24 hours/)).toBeVisible();
});
