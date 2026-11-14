import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { launchIso, launchLabel } from '../../apps/web/src/lib/countdown';

const launchAt = Date.parse(process.env.E2E_PRODUCTION_LAUNCH_AT ?? '');

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
        name: 'A little tip is almost here.',
      }),
    ).toBeVisible();
    await expect(
      page.getByText('TipMe opens at midnight in Lagos.'),
    ).toBeVisible();
    // The date line follows the launch time the run sets, not a fixed date.
    const date = page.getByRole('main').locator('.coming-soon__foot time');
    await expect(date).toHaveText(launchLabel(launchAt));
    await expect(date).toHaveAttribute('datetime', launchIso(launchAt));
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
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    // Two by two on a phone.
    const tops = await page
      .locator('.launch-countdown__tile')
      .evaluateAll((tiles) =>
        tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)),
      );
    expect(new Set(tops).size).toBe(2);
    expect(tops[0]).toBe(tops[1]);
    expect(tops[2]).toBe(tops[3]);
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

  test('the tiles are keys in a well, the headline is DM Serif, the eyebrow is sentence case', async ({
    page,
  }) => {
    await page.goto('/coming-soon');
    const main = page.getByRole('main');
    await expect(
      main.locator('.launch-countdown__value').first(),
    ).not.toHaveText('––');
    const look = await page.evaluate(() => {
      const css = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`missing ${selector}`);
        return getComputedStyle(element);
      };
      const probe = document.createElement('i');
      probe.style.backgroundColor = 'var(--surface-recessed)';
      document.body.append(probe);
      const recessed = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = 'var(--brand-primary)';
      const purple = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        h1Font: css('.coming-soon__intro h1').fontFamily,
        eyebrowCase: css('.coming-soon__eyebrow').textTransform,
        labelCase: css('.launch-countdown__label').textTransform,
        wellBackground: css('.launch-countdown__grid').backgroundColor,
        wellShadow: css('.launch-countdown__grid').boxShadow,
        recessed,
        secondsBackground: css('.launch-countdown__tile--seconds')
          .backgroundColor,
        secondsImage: css('.launch-countdown__tile--seconds').backgroundImage,
        purple,
        dayImage: css('.launch-countdown__tile--days').backgroundImage,
      };
    });
    expect(look.h1Font).toMatch(/dmSerif|DM Serif/);
    expect(look.eyebrowCase).toBe('none');
    expect(look.labelCase).toBe('none');
    expect(look.wellBackground).toBe(look.recessed);
    expect(look.wellShadow).toContain('inset');
    // Seconds stays the purple key.
    expect(
      look.secondsBackground === look.purple ||
        look.secondsImage.includes('gradient'),
    ).toBe(true);
    expect(look.dayImage).toContain('linear-gradient');
  });

  test('the paper card is hidden from screen readers and shows the site host', async ({
    page,
  }) => {
    await page.goto('/coming-soon');
    const card = page.getByRole('main').locator('.coming-soon__card');
    await expect(card).toHaveAttribute('aria-hidden', 'true');
    await expect(card).toContainText('Your page');
    // The host comes from SITE_URL (unset in this run, so the local default).
    await expect(card.locator('.coming-soon__card-link')).toHaveText(
      'localhost:3000/@yourname',
    );
    await expect(card).toContainText('Tip');
    await expect(card).toBeVisible();
  });

  test('serves no-store rewrites, countdown metadata and operational exemptions', async ({
    request,
  }) => {
    const held = await request.get('/ops');
    expect(held.headers()['cache-control']).toContain('no-store');
    expect(held.headers()['cdn-cache-control']).toBe('no-store');
    expect(held.headers()['vercel-cdn-cache-control']).toBe('no-store');
    expect(await held.text()).toContain('A little tip is almost here.');

    const direct = await request.get('/coming-soon');
    const html = await direct.text();
    expect(html).toContain('A little tip is almost here.');
    expect(html).toContain('/coming-soon/opengraph-image');

    for (const path of [
      '/robots.txt',
      '/sitemap.xml',
      '/api/revalidate',
      '/opengraph-image',
    ]) {
      const response = await request.get(path);
      expect(await response.text(), path).not.toContain(
        'A little tip is almost here.',
      );
      if (path === '/opengraph-image') {
        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toContain('image/');
      }
    }
    const image = await request.get('/coming-soon/opengraph-image');
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toBe('image/png');
  });
});
