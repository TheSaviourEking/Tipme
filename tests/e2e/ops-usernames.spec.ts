import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, identity, signInWithEmail } from './helpers';
import { enrolOwner } from './ops-helpers';

// Staff reserve and release usernames at /ops/usernames (usernames.manage). Names carry the test's
// own digits, so parallel projects never reserve the same one.
const REASON = 'A telecoms brand asked us to hold it';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Admin' });
const checkCard = (page: Page) =>
  page
    .locator('.settings-section')
    .filter({ has: page.getByRole('heading', { name: 'Check a name' }) });

async function checkName(page: Page, name: string) {
  await checkCard(page).getByLabel('Name', { exact: true }).fill(name);
  await checkCard(page).getByRole('button', { name: 'Check' }).click();
}

test('staff reserve a name, sign-up refuses it, and staff release it', async ({
  page,
  browser,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const name = `mtnx${identity(testInfo).handle.slice(4)}`;
  await nav(page).getByRole('link', { name: 'Usernames' }).click();
  await expect(page.getByRole('heading', { name: 'Usernames' })).toBeVisible();

  // Typed in another case: one name.
  await checkName(page, name.toUpperCase());
  await expect(checkCard(page).getByText('Free.')).toBeVisible();
  await expectAccessible(page);
  await checkCard(page).getByRole('button', { name: 'Reserve…' }).click();
  await checkCard(page).getByLabel('Why reserve this username?').fill(REASON);
  await checkCard(page)
    .getByRole('button', { name: 'Reserve this username' })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Reserved' }),
  ).toContainText(`Nobody can claim @${name}`);
  await expect(checkCard(page).getByText('Reserved.')).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: `@${name}` });
  await expect(row).toContainText(REASON);
  await expect(row).toContainText('Staff');
  await expectAccessible(page);

  // Someone signing up is told it is reserved, as for TipMe's own words.
  const theirs = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  const them = await theirs.newPage();
  const { email } = identity({ ...testInfo, workerIndex: 8 });
  await signInWithEmail(them, email, '/sign-up');
  await them.getByLabel('Handle').fill(name);
  await expect(
    them.getByText('That handle is reserved. Try another.'),
  ).toBeVisible();

  await checkCard(page).getByRole('button', { name: 'Release…' }).click();
  await checkCard(page)
    .getByLabel('Why release this username?')
    .fill('The brand no longer needs it');
  await checkCard(page)
    .getByRole('button', { name: 'Release this username' })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Released' }),
  ).toContainText(`@${name} is free again`);
  await expect(checkCard(page).getByText('Free.')).toBeVisible();
  await expect(row).toHaveCount(0);

  await them.getByLabel('Handle').fill('');
  await them.getByLabel('Handle').fill(name);
  await expect(them.getByText(`@${name} is available`)).toBeVisible();
  await theirs.close();
});

test('a built-in name shows no Reserve or Release, and the built-in list is folded by default', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.goto('/ops/usernames');
  const builtIn = page
    .locator('details')
    .filter({ hasText: 'TipMe’s own list' });
  await expect(builtIn).toBeVisible();
  await expect(builtIn).not.toHaveAttribute('open', '');
  await expect(builtIn.getByText(/\bdashboard\b/)).toBeHidden();
  await builtIn.locator('summary').click();
  await expect(builtIn.getByText(/\bdashboard\b/)).toBeVisible();

  await checkName(page, 'Admin');
  await expect(checkCard(page).getByText('Built in.')).toBeVisible();
  await expect(
    checkCard(page).getByRole('button', { name: /Reserve|Release/ }),
  ).toHaveCount(0);
  await expectAccessible(page);
});
