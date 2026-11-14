import { expect, test } from '@playwright/test';

// Owner, 2 Nov 2026: the header asks "Who it's for" and answers with three choices. Infrastructure
// is not open yet, so it says so and has no page to go to. Businesses follows BUSINESS_ENABLED
// (PR B1): the e2e stack has it on, so it reads "Businesses"; "Businesses (coming soon)" while it is
// off is tested on a stand-in stack in business-setup.spec.ts.

test("Who it's for opens a menu of individuals, businesses and infrastructure", async ({
  page,
}) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const who = nav.getByRole('button', { name: "Who it's for" });
  await expect(who).toHaveAttribute('aria-expanded', 'false');
  await who.click();
  await expect(who).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link', { name: /^Individuals/ })).toHaveAttribute(
    'href',
    '/for-creators',
  );
  await expect(
    nav.getByRole('link', { name: /^Businesses\s*Create your business/ }),
  ).toHaveAttribute('href', '/for-businesses');
  // Infrastructure is words only: nothing to click until there is somewhere to go.
  await expect(nav.getByText('Infrastructure (coming soon)')).toBeVisible();
  await expect(nav.getByText('Consume the Tipme APIs.')).toBeVisible();
  await expect(nav.getByRole('link', { name: /Infrastructure/ })).toHaveCount(
    0,
  );
  await page.keyboard.press('Escape');
  await expect(who).toHaveAttribute('aria-expanded', 'false');
  await expect(who).toBeFocused();
  await expect(nav.getByRole('link', { name: /^Individuals/ })).toBeHidden();
});

test(
  'on a phone the menu button opens the same choices as raised cards',
  { tag: '@mobile' },
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Phone width only.');
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const items = [
      nav.getByRole('link', { name: /^Individuals/ }),
      nav.getByRole('link', { name: /^Businesses\s*Create your business/ }),
      nav.getByText('Infrastructure (coming soon)'),
    ];
    for (const item of items) {
      await expect(item).toBeVisible();
      // The text sits inside the card; the card itself is what a thumb lands on.
      const card = item.locator('xpath=ancestor-or-self::*[@data-who-item]');
      const height = (await card.boundingBox())?.height ?? 0;
      expect(height).toBeGreaterThanOrEqual(44);
    }
    await expect(nav.getByText('Consume the Tipme APIs.')).toBeVisible();
    await expect(nav.getByRole('link', { name: /Infrastructure/ })).toHaveCount(
      0,
    );
  },
);

test(
  'on a phone the open menu is a full page with a close button, and keeps focus inside',
  { tag: '@mobile' },
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Phone width only.');
    await page.goto('/');
    const open = page.getByRole('button', { name: 'Open menu' });
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await open.click();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    // The menu takes over the whole screen, and the page beneath does not scroll.
    const covered = await nav.evaluate((el) => {
      const { top, left, width, height } = el.getBoundingClientRect();
      return { top, left, width, height, vw: innerWidth, vh: innerHeight };
    });
    expect(covered).toMatchObject({ top: 0, left: 0 });
    expect(covered.width).toBe(covered.vw);
    expect(covered.height).toBeGreaterThanOrEqual(covered.vh);
    expect(
      await page.evaluate(() => getComputedStyle(document.body).overflow),
    ).toBe('hidden');
    // An icon-only close button, at least 44px square, and the order of the board.
    const close = nav.getByRole('button', { name: 'Close menu' });
    await expect(close).toBeVisible();
    const size = (await close.boundingBox()) ?? { width: 0, height: 0 };
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
    await expect(close).toBeFocused();
    // The action to start is pinned to the bottom of the screen.
    // Business sign-up is on in the e2e stack: the action reads "Get tipped".
    const create = nav.getByRole('link', { name: 'Get tipped' });
    const end = await create.boundingBox();
    expect((end?.y ?? 0) + (end?.height ?? 0)).toBeGreaterThan(covered.vh - 40);
    // Tab goes round inside the menu and never reaches the page beneath.
    const inside = nav.locator('a[href], button');
    const count = await inside.evaluateAll(
      (nodes) => nodes.filter((n) => n.getClientRects().length > 0).length,
    );
    for (let press = 0; press < count + 2; press += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() =>
          document.activeElement?.closest('#site-navigation') ? true : false,
        ),
      ).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(
      await page.evaluate(() =>
        document.activeElement?.closest('#site-navigation') ? true : false,
      ),
    ).toBe(true);
    // Closing with the button puts the focus back on the button that opened it.
    await close.click();
    await expect(close).toBeHidden();
    await expect(open).toBeVisible();
    await expect(open).toBeFocused();
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(
      await page.evaluate(() => getComputedStyle(document.body).overflow),
    ).not.toBe('hidden');
    // Escape closes it too.
    await open.click();
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
    await expect(close).toBeHidden();
  },
);

test('the header has a Pro link that marks the Pro page as current', async ({
  page,
}, testInfo) => {
  await page.goto('/pro');
  if (testInfo.project.name === 'mobile')
    await page.getByRole('button', { name: 'Open menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const pro = nav.getByRole('link', { name: 'Pro', exact: true });
  await expect(pro).toHaveAttribute('href', '/pro');
  await expect(pro).toHaveAttribute('aria-current', 'page');
});
