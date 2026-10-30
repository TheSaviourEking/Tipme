import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  identity,
  signInWithEmail,
  signUpRecipient,
} from './helpers';

test('a new recipient signs up, claims a handle and controls whether the page is live', async ({
  page,
  browser,
}, testInfo) => {
  const { email, handle } = identity(testInfo);
  await signInWithEmail(page, email, '/sign-up');
  await expect(
    page.getByRole('heading', { name: 'Choose your handle' }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Handle').fill(handle);
  await expect(page.getByText(`@${handle} is available`)).toBeVisible();
  await page.getByRole('button', { name: `Claim @${handle}` }).click();
  await page.waitForURL(/\/dashboard\/welcome$/);
  await expect(
    page.getByRole('heading', { name: 'Welcome to TipMe.' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'I’ll do this later' }).click();
  await page.goto('/dashboard/settings');
  await expect(page.getByText('Your page is not live')).toBeVisible();
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/@${handle}`);
  await expect(
    visitor.getByRole('heading', {
      name: 'This page isn’t available right now',
    }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Make my page live' }).click();
  await expect(page.getByText('Your page is live')).toBeVisible();
  await expect(async () => {
    await visitor.reload();
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(
      handle,
      { timeout: 1000 },
    );
  }).toPass({ timeout: 5000 });

  await page.getByLabel('Display name').fill('Kemi Bello');
  await page.getByLabel('What you do').fill('Hairdresser at Glow Studio');
  await page.getByLabel('Bio', { exact: true }).fill('Braids and kindness.');
  await page.getByLabel('Instagram link').fill('https://instagram.com/kemi');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await expect(async () => {
    await visitor.reload();
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(
      'Kemi Bello',
      { timeout: 1000 },
    );
  }).toPass({ timeout: 5000 });
  await expect(visitor.getByText('Hairdresser at Glow Studio')).toBeVisible();
  await expect(
    visitor.getByRole('link', { name: 'Instagram' }),
  ).toHaveAttribute('href', 'https://instagram.com/kemi');

  await page.getByRole('button', { name: 'Take my page offline' }).click();
  await expect(page.getByText('Your page is not live')).toBeVisible();
  await expect(async () => {
    await visitor.reload();
    await expect(
      visitor.getByRole('heading', {
        name: 'This page isn’t available right now',
      }),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 5000 });
  expect(await fitsViewport(page)).toBe(true);

  // The owner is told on every dashboard page, with the one step that fixes it.
  const attention = page.getByRole('region', { name: 'Needs your attention' });
  await expect(attention.getByText('Your page is offline')).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(attention.getByText('Your page is offline')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Settings (needs your attention)' }),
  ).toBeVisible();
  await attention.getByRole('link', { name: 'Make my page live' }).click();
  await page.getByRole('button', { name: 'Make my page live' }).click();
  await expect(attention).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Settings', exact: true }),
  ).toBeVisible();
});

test('a session survives a reload and signing out ends it', async ({
  page,
}, testInfo) => {
  // One identity: each call makes a new one from the clock.
  const who = identity(testInfo);
  await signInWithEmail(page, who.email, '/sign-up');
  await page.waitForURL(/\/sign-up|\/dashboard/);
  await page.getByLabel('Handle').waitFor();
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByRole('button', { name: `Claim @${who.handle}` }).click();
  // A new page lands on the welcome, which has no toolbar.
  await page.waitForURL(/\/dashboard\/welcome$/);
  await page.goto('/dashboard');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/sign-in/);
  await page.goto('/dashboard/settings');
  await page.waitForURL(/\/sign-in\?next=/);
  await expectAccessible(page);
});

test('the seeded demo pages render from the database', async ({ page }) => {
  await page.goto('/@ada');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Ada Okafor',
  );
  await expect(
    page.getByText('Designer & generous internet person'),
  ).toBeVisible();
  await page.goto('/@nobody_here');
  await expect(
    page.getByRole('heading', { name: 'This page isn’t available right now' }),
  ).toBeVisible();
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
    'content',
    /noindex/,
  );
  await expectAccessible(page);
});

test('fix: a page taken offline without a refresh signal still disappears within the cache backstop', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const { handle } = await signUpRecipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(
      handle,
      { timeout: 1000 },
    );
  }).toPass({ timeout: 10_000 });
  // Straight in the database: no revalidation signal reaches the web app.
  const { openTestDatabase } =
    await import('../../packages/database/dist/test-support.js');
  const database = await openTestDatabase();
  try {
    await database.pool.query(
      "UPDATE profiles SET page_state = 'not_live' WHERE handle_lower = $1",
      [handle],
    );
  } finally {
    await database.close();
  }
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(
      visitor.getByRole('heading', {
        name: 'This page isn’t available right now',
      }),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 70_000, intervals: [5000] });
});
