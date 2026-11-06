import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, identity, signInWithEmail } from './helpers';
import { enrolOwner, sql, withDatabase } from './ops-helpers';

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

// Review I1: a refusal from the Check card stays visible and never reads as this person's success,
// even though the card re-reads the name and now shows what holds it.
test('a refusal on the Check card is shown, and never looks like your own success', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const digits = identity(testInfo).handle.slice(4);
  await page.goto('/ops/usernames');

  // Someone else reserves it while this card still says Free.
  const taken = `race${digits}`;
  await checkName(page, taken);
  await expect(checkCard(page).getByText('Free.')).toBeVisible();
  await checkCard(page).getByRole('button', { name: 'Reserve…' }).click();
  await checkCard(page).getByLabel('Why reserve this username?').fill(REASON);
  await withDatabase(async (db, ops) => {
    const [other] = await sql<{ id: string }>(
      `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
      [`other.${digits}@example.com`],
    );
    await ops.reserveUsername(db, {
      staffId: other!.id,
      name: taken,
      reason: 'Reserved first by a colleague',
    });
  });
  await checkCard(page)
    .getByRole('button', { name: 'Reserve this username' })
    .click();
  const refusal = page.getByRole('alert').filter({ hasText: 'Not done' });
  await expect(refusal).toContainText('This username is already reserved');
  await expect(
    page.getByRole('status').filter({ hasText: 'Nobody can claim' }),
  ).toHaveCount(0);
  // The card shows the colleague's reservation, not this person's reason.
  await expect(
    checkCard(page).getByText('Reserved first by a colleague'),
  ).toBeVisible();
  await expect(checkCard(page).getByText(REASON)).toHaveCount(0);
  await expectAccessible(page);

  // A page claims it meanwhile: the words name the page.
  const held = `held${digits}`;
  await checkName(page, held);
  await expect(checkCard(page).getByText('Free.')).toBeVisible();
  await checkCard(page).getByRole('button', { name: 'Reserve…' }).click();
  await checkCard(page).getByLabel('Why reserve this username?').fill(REASON);
  await sql(
    `INSERT INTO profiles (id, handle, handle_lower, display_name) VALUES (gen_random_uuid(), $1, $1, 'Held page')`,
    [held],
  );
  await checkCard(page)
    .getByRole('button', { name: 'Reserve this username' })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Not done' }),
  ).toContainText(
    `This is @${held}’s username. To take it, ask to take it back.`,
  );
  await expect(checkCard(page).getByText(`@${held}’s username.`)).toBeVisible();

  // Released by someone else meanwhile: Release says it isn't reserved, never "Released".
  await checkName(page, taken);
  await expect(checkCard(page).getByText('Reserved.')).toBeVisible();
  await checkCard(page).getByRole('button', { name: 'Release…' }).click();
  await checkCard(page)
    .getByLabel('Why release this username?')
    .fill('The brand no longer needs it');
  await sql(
    `UPDATE handle_reservations SET released_at = now(), released_by = reserved_by, release_reason = 'Freed by a colleague' WHERE handle_lower = $1 AND released_at IS NULL`,
    [taken],
  );
  await checkCard(page)
    .getByRole('button', { name: 'Release this username' })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Not done' }),
  ).toContainText('This username isn’t reserved');
  await expect(
    page.getByRole('status').filter({ hasText: 'is free again' }),
  ).toHaveCount(0);
  await expect(checkCard(page).getByText('Free.')).toBeVisible();
});
