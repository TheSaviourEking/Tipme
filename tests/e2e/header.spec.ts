import { expect, test } from '@playwright/test';

// The marketing header is sticky, and its "Claim your username" button steps aside while Home's hero
// claim form is on screen (owner, 5 Nov 2026). On phones the button lives in the open menu only.

const claim = (page: import('@playwright/test').Page) =>
  page.locator('.site-header .nav-claim');

test('on Home the header button is hidden at the top, shown past the form, hidden again on return', async ({
  page,
}) => {
  await page.goto('/');
  await expect(claim(page)).toBeHidden();
  await page.evaluate(() =>
    window.scrollTo({ top: 1400, behavior: 'instant' }),
  );
  await expect(claim(page)).toBeVisible();
  await expect(claim(page)).toHaveText(/Claim your username/);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(claim(page)).toBeHidden();
});

test('while hidden the header button cannot be focused or reached', async ({
  page,
}) => {
  await page.goto('/');
  await expect(claim(page)).toBeHidden();
  const visibility = await claim(page).evaluate(
    (node) => getComputedStyle(node).visibility,
  );
  expect(visibility).toBe('hidden');
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', {
        name: 'Claim your username',
      }),
  ).toHaveCount(0);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('the header button is shown', async ({ page }) => {
    await page.goto('/');
    await expect(claim(page)).toBeVisible();
  });
});

for (const path of ['/', '/pro']) {
  test(`the header stays at the top of the screen after scrolling ${path}`, async ({
    page,
  }) => {
    await page.goto(path);
    await page.evaluate(() =>
      window.scrollTo({ top: 900, behavior: 'instant' }),
    );
    const header = page.locator('.site-header');
    await expect(header).toBeInViewport();
    expect((await header.boundingBox())?.y).toBe(0);
    const covers = await page.evaluate(() => {
      const box = document
        .querySelector('.site-header')!
        .getBoundingClientRect();
      const hit = document.elementFromPoint(40, box.bottom - 4);
      return Boolean(hit?.closest('.site-header'));
    });
    expect(covers).toBe(true);
  });
}

test('on another page the header button is shown at load', async ({ page }) => {
  await page.goto('/for-creators');
  await expect(claim(page)).toBeVisible();
});

test('an in-page jump to How it works lands below the header', async ({
  page,
}) => {
  await page.goto('/#how-it-works');
  // The jump may glide: wait for it to stop, then the section must start below the header.
  await expect
    .poll(async () => {
      const header = await page.locator('.site-header').boundingBox();
      const target = await page.locator('#how-it-works').boundingBox();
      return (target?.y ?? 0) - ((header?.y ?? 0) + (header?.height ?? 0));
    })
    .toBeGreaterThanOrEqual(-1);
});

test('@mobile on a phone the closed header has no claim button; the open menu has it', async ({
  page,
}) => {
  await page.goto('/');
  const header = page.locator('.site-header');
  await expect(
    header.getByRole('link', { name: 'Claim your username' }),
  ).toBeHidden();
  await page.evaluate(() =>
    window.scrollTo({ top: 1400, behavior: 'instant' }),
  );
  await expect(
    header.getByRole('link', { name: 'Claim your username' }),
  ).toBeHidden();
  expect((await header.boundingBox())?.y).toBe(0);
  await page.getByRole('button', { name: 'Open menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(
    nav.getByRole('link', { name: 'Claim your username' }),
  ).toBeVisible();
  await expect(
    nav.getByRole('link', { name: 'Claim your username' }),
  ).toHaveAttribute('href', '/sign-up');
});
