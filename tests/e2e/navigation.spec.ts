import { expect, test } from '@playwright/test';

// Owner, 2 Nov 2026: the header asks "Who it's for" and answers with three choices. Businesses and
// infrastructure are not open yet, so they say so; infrastructure has no page to go to.

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
    nav.getByRole('link', { name: /^Businesses \(coming soon\)/ }),
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
    await page.getByRole('button', { name: 'Menu' }).click();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const items = [
      nav.getByRole('link', { name: /^Individuals/ }),
      nav.getByRole('link', { name: /^Businesses \(coming soon\)/ }),
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
