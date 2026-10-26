import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('production countdown', () => {
  test.skip(
    !process.env.E2E_PRODUCTION_LAUNCH_AT,
    'Runs only against a build with the future launch gate enabled.',
  );

  test('preserves the requested URL and presents one focused holding page', async ({
    page,
  }) => {
    await page.goto('/dashboard?from=countdown');
    await expect(page).toHaveURL(/\/dashboard\?from=countdown$/);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'A little thanks is almost here.',
      }),
    ).toBeVisible();
    await expect(
      page.getByText('TipMe opens at midnight in Lagos.'),
    ).toBeVisible();
    await expect(page.getByText('27 October 2026 · 00:00 WAT')).toHaveAttribute(
      'datetime',
      '2026-10-26T23:00:00Z',
    );
    await expect(page.locator('.site-header')).toBeHidden();
    await expect(page.locator('.site-footer')).toBeHidden();
    await expect(page.locator('.launch-countdown__tile')).toHaveCount(4);
    await expect(
      page.locator('.launch-countdown [aria-live="polite"]'),
    ).toHaveCount(1);

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(violations).toEqual([]);
  });

  test('reflows at 320px and removes motion when requested', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const transitions = await page
      .locator('.launch-countdown__tile')
      .evaluateAll((tiles) =>
        tiles.map((tile) => getComputedStyle(tile).transitionDuration),
      );
    // Chromium reports CSS `transition: none` as its effectively-zero floor.
    expect(
      transitions.every((duration) => Number.parseFloat(duration) <= 0.001),
    ).toBe(true);
  });

  test('serves no-store rewrites, countdown metadata and operational exemptions', async ({
    request,
  }) => {
    const held = await request.get('/ops');
    expect(held.headers()['cache-control']).toContain('no-store');
    expect(held.headers()['cdn-cache-control']).toBe('no-store');
    expect(held.headers()['vercel-cdn-cache-control']).toBe('no-store');
    expect(await held.text()).toContain('A little thanks is almost here.');

    const direct = await request.get('/coming-soon');
    const html = await direct.text();
    expect(html).toContain('A little thanks is almost here.');
    expect(html).toContain('/coming-soon/opengraph-image');

    for (const path of ['/robots.txt', '/sitemap.xml', '/api/revalidate']) {
      const response = await request.get(path);
      expect(await response.text(), path).not.toContain(
        'A little thanks is almost here.',
      );
    }
    const image = await request.get('/coming-soon/opengraph-image');
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toBe('image/png');
  });
});
