import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  identity,
  signInWithEmail,
  signUpRecipient,
} from './helpers';
import { CONNECTION_COPY } from '../../apps/web/src/lib/connection-copy';

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
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  const links = page.locator('.settings-section', {
    has: page.getByRole('heading', { name: 'Your links' }),
  });
  await links.getByLabel('Add a link').fill('https://instagram.com/kemi');
  await links.getByRole('button', { name: 'Add', exact: true }).click();
  await links.getByRole('button', { name: 'Save links' }).click();
  await expect(links.getByRole('status')).toHaveText('Saved');
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
  await expect(attention.getByText('Your page is offline')).toHaveCount(0);
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

test('the code is one field shown as six cells', async ({ page }, testInfo) => {
  const { email } = identity(testInfo);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  const field = page.locator('input[autocomplete="one-time-code"]');
  await expect(field).toHaveCount(1);
  await expect(field).toHaveAttribute('inputmode', 'numeric');
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  const cells = page.locator('.tm-code-cell');
  await expect(cells).toHaveCount(6);

  await field.pressSequentially('123456');
  await expect(cells).toHaveText(['1', '2', '3', '4', '5', '6']);

  // Backspace works on the one real field, and a paste (or an autofill) fills every cell at once.
  await field.press('Backspace');
  await expect(cells).toHaveText(['1', '2', '3', '4', '5', '']);
  await field.fill('');
  await page.keyboard.insertText('123456');
  await expect(cells).toHaveText(['1', '2', '3', '4', '5', '6']);
  await expect(field).toHaveValue('123456');
  // The cells are drawn only: a screen reader meets the one labelled field.
  await expect(
    page.locator('.tm-code-cells[aria-hidden="true"] .tm-code-cell'),
  ).toHaveCount(6);
});

test('the welcome preview follows what you type @mobile', async ({
  page,
}, testInfo) => {
  const who = identity(testInfo);
  await signInWithEmail(page, who.email, '/sign-up');
  // The code was typed into the one field; the handle step has no code cells.
  await page.getByLabel('Handle').fill(who.handle);
  await expect(page.getByText(`@${who.handle} is available`)).toBeVisible();
  await page.getByRole('button', { name: `Claim @${who.handle}` }).click();
  await page.waitForURL(/\/dashboard\/welcome$/);
  await page.getByRole('button', { name: 'Let’s set up your page' }).click();
  await page.getByLabel('What you do').fill('Maths tutor');
  const preview = page.getByRole('complementary', {
    name: 'Preview of your page',
  });
  await expect(preview).toContainText('Maths tutor');
  await expect(preview).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
});

test('recovery says what happens next whatever the address @mobile', async ({
  page,
}) => {
  for (const address of ['nobody-at-all@example.com', 'someone@example.org']) {
    await page.goto('/recover');
    await page.getByLabel('Your sign-in email').fill(address);
    await page.getByRole('button', { name: 'Send recovery code' }).click();
    await expect(
      page.getByText(
        'If that email matches an account, the next step is on its way.',
      ),
    ).toBeVisible();
  }
  expect(await fitsViewport(page)).toBe(true);
});

/** A real paste: the text goes to the clipboard and Ctrl/Cmd+V pastes it into the focused field. */
async function pasteInto(
  page: import('@playwright/test').Page,
  field: import('@playwright/test').Locator,
  text: string,
) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await field.fill('');
  await field.focus();
  await page.keyboard.press('ControlOrMeta+V');
}

const SIX = ['1', '2', '3', '4', '5', '6'];

test('a code pasted with spaces or dashes still fills all six cells', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { email } = identity(testInfo);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  const field = page.getByLabel('6-digit code');
  await expect(field).toBeVisible();
  const cells = page.locator('.tm-code-cell');
  for (const pasted of ['123 456', '123-456', ' 123456 ']) {
    await pasteInto(page, field, pasted);
    await expect(field).toHaveValue('123456');
    await expect(cells).toHaveText(SIX);
  }
  // A seventh digit has nowhere to go.
  await field.fill('');
  await field.pressSequentially('1234567');
  await expect(field).toHaveValue('123456');
  await expect(cells).toHaveText(SIX);
});

test('a recovery code pasted with spaces or dashes still fills all six cells', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/recover');
  await page.getByLabel('Your sign-in email').fill('nobody@example.com');
  await page.getByRole('button', { name: 'Send recovery code' }).click();
  const field = page.getByLabel('Code sent to your recovery email');
  await expect(field).toBeVisible();
  const cells = page.locator('.tm-code-cell');
  for (const pasted of ['123 456', '123-456', ' 123456 ']) {
    await pasteInto(page, field, pasted);
    await expect(field).toHaveValue('123456');
    await expect(cells).toHaveText(SIX);
  }
});

// States plan, Task 16: one quiet retry for the code check, never for sending a code.
const SIGN_IN_CODE_USED = CONNECTION_COPY.signInCodeUsed;

test('a dropped code check is retried once quietly and signs in', async ({
  page,
}, testInfo) => {
  const { email } = identity(testInfo);
  let checks = 0;
  await page.route('**/v1/auth/verify', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    checks += 1;
    return checks === 1 ? route.abort() : route.fallback();
  });
  await signInWithEmail(page, email, '/sign-up');
  await expect(
    page.getByRole('heading', { name: 'Choose your handle' }),
  ).toBeVisible();
  expect(checks).toBe(2);
});

test('a code used by a dropped first try asks for a new code', async ({
  page,
}, testInfo) => {
  const { email } = identity(testInfo);
  let checks = 0;
  await page.route('**/v1/auth/verify', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    checks += 1;
    if (checks > 1) return route.fallback();
    // The first check reaches TipMe and uses the code; only its answer is lost.
    await route.fetch();
    return route.abort();
  });
  await signInWithEmail(page, email, '/sign-up');
  await expect(
    page.getByRole('alert').filter({ hasText: SIGN_IN_CODE_USED }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send a new code' }),
  ).toHaveAttribute('data-suggested', 'true');
  expect(checks).toBe(2);
  await expectAccessible(page);
});

test('sending a code is never retried quietly', async ({ page }, testInfo) => {
  const { email } = identity(testInfo);
  let sends = 0;
  await page.route('**/v1/auth/code', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sends += 1;
    return route.abort();
  });
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(
    page.getByText(
      'We couldn’t send a code. Check your connection and try again.',
    ),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  expect(sends).toBe(1);
});

test('a code check dropped twice says the connection dropped', async ({
  page,
}, testInfo) => {
  const { email } = identity(testInfo);
  let checks = 0;
  await page.route('**/v1/auth/verify', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    checks += 1;
    return route.abort();
  });
  await signInWithEmail(page, email, '/sign-up');
  await expect(
    page.getByRole('alert').filter({ hasText: CONNECTION_COPY.signInDropped }),
  ).toBeVisible();
  await expect(page.getByText(/your code still works/i)).toHaveCount(0);
  expect(checks).toBe(2);
});
