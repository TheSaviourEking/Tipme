import { expect, test, type Locator } from '@playwright/test';
import { identity, signInWithEmail, signUpRecipient } from './helpers';
import { enrolOwner, openOpsLink } from './ops-helpers';

// The owner, 15 Nov 2026: a person's @name is their "username" on screen, never their
// "handle". Code, routes and API fields keep `handle`; only the words people read changed.
async function saysUsernameNotHandle(region: Locator) {
  await expect(region).toContainText(/username/i);
  await expect(region).not.toContainText(/\bhandles?\b/i);
}

test('the sign-up step asks for a username, not a handle', async ({
  page,
}, testInfo) => {
  const who = identity(testInfo);
  await signInWithEmail(page, who.email, '/sign-up');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { name: 'Choose your username' }),
  ).toBeVisible();
  await expect(main.getByLabel('Username', { exact: true })).toBeVisible();
  await saysUsernameNotHandle(main);
});

test('Settings and the admin Pages screen say username, not handle', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo, { live: false });
  const section = page.locator('#handle');
  await expect(section.getByText(`Username: @${handle}`)).toBeVisible();
  await expect(
    section.getByText('Username changes are part of TipMe Pro.'),
  ).toBeVisible();
  await saysUsernameNotHandle(section);

  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await openOpsLink(staff, 'Pages');
  const main = staff.getByRole('main');
  await main.getByLabel('Username', { exact: true }).fill(handle);
  await main.getByRole('button', { name: 'Find page' }).click();
  await expect(
    main.getByRole('heading', { level: 2, name: `@${handle}` }),
  ).toBeVisible();
  await expect(
    main.getByRole('heading', { level: 2, name: 'Username changes' }),
  ).toBeVisible();
  await saysUsernameNotHandle(main);
  await staff.context().close();
});
