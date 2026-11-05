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
  // The jump may glide: wait until the scroll has moved and then stopped, then check the landing.
  let last = -1;
  await expect
    .poll(async () => {
      const now = await page.evaluate(() => window.scrollY);
      const settled = now > 0 && now === last;
      last = now;
      return settled;
    })
    .toBe(true);
  const header = await page.locator('.site-header').boundingBox();
  const target = await page.locator('#how-it-works').boundingBox();
  expect(
    (target?.y ?? 0) - ((header?.y ?? 0) + (header?.height ?? 0)),
  ).toBeGreaterThanOrEqual(-1);
});

test('a focused header button stays shown and focused when the hero form returns', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() =>
    window.scrollTo({ top: 1400, behavior: 'instant' }),
  );
  await expect(claim(page)).toBeVisible();
  await claim(page).focus();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.locator('html')).toHaveAttribute('data-hero-claim', 'in');
  await expect(claim(page)).toBeFocused();
  await expect(claim(page)).toBeVisible();
  // Once focus leaves it, it steps aside as usual.
  await page.locator('.home-claim input').focus();
  await expect(claim(page)).toBeHidden();
});

test('a form scrolled up under the sticky header does not hide the button as well', async ({
  page,
}) => {
  await page.goto('/');
  const hidden = await page.evaluate(() => {
    const form = document.querySelector('.home-claim')!.getBoundingClientRect();
    window.scrollTo({
      top: window.scrollY + form.bottom - 40,
      behavior: 'instant',
    });
  });
  void hidden;
  await expect(claim(page)).toBeVisible();
});

test.describe('with motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('the button slides in and ends up shown', async ({ page }) => {
    await page.goto('/');
    expect(
      await claim(page).evaluate((n) => getComputedStyle(n).transitionDuration),
    ).not.toBe('0s');
    await page.evaluate(() =>
      window.scrollTo({ top: 1400, behavior: 'instant' }),
    );
    await expect(claim(page)).toBeVisible();
    await expect
      .poll(() => claim(page).evaluate((n) => getComputedStyle(n).opacity))
      .toBe('1');
  });
});

test('with reduced motion the button has no transition', async ({ page }) => {
  await page.goto('/');
  // Effectively none: the global reduced-motion rule leaves 0.01ms.
  const seconds = await claim(page).evaluate((n) =>
    Number.parseFloat(getComputedStyle(n).transitionDuration),
  );
  expect(seconds).toBeLessThan(0.001);
});

test('the Who it’s for popover opens over the page while the header is stuck', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() =>
    window.scrollTo({ top: 1400, behavior: 'instant' }),
  );
  await page.getByRole('button', { name: /Who it.s for/ }).click();
  const menu = page.locator('.who__menu');
  await expect(menu).toBeVisible();
  const onTop = await menu.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
    return Boolean(hit && node.contains(hit));
  });
  expect(onTop).toBe(true);
});

test('the header is sticky on the marketing pages only', async ({ page }) => {
  const position = () =>
    page.locator('.site-header').evaluate((n) => getComputedStyle(n).position);
  for (const path of [
    '/pro',
    '/for-creators',
    '/for-businesses',
    '/legal/terms',
    '/legal/privacy',
  ]) {
    await page.goto(path);
    expect(await position(), path).toBe('sticky');
  }
  for (const path of ['/@ada', '/sign-in', '/sign-up', '/recover']) {
    await page.goto(path);
    expect(await position(), path).not.toBe('sticky');
  }
});

test('the public tip page header is not sticky at a phone width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/@ada');
  expect(
    await page
      .locator('.site-header')
      .evaluate((n) => getComputedStyle(n).position),
  ).not.toBe('sticky');
  await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));
  expect(
    (await page.locator('.site-header').boundingBox())?.y ?? 0,
  ).toBeLessThan(0);
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
