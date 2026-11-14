import { expect, test } from '@playwright/test';

// The board's three Page Studio pages at a phone and a wide desktop (plan Task 6). Linux CI is the
// authority for these images; the Darwin copies are for local runs (as profile.visual).
for (const name of ['kemi', 'sule', 'ify'])
  for (const width of [390, 1440])
    test(`Page Studio ${name} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/dev/studio-lab?example=${name}`);
      await page.locator('.studio').waitFor();
      await page.evaluate(() => document.fonts.ready);
      // Photos are generated SVGs; wait for every one in view so the capture is stable.
      await page.waitForFunction(() =>
        [...document.images].every((i) => i.loading === 'lazy' || i.complete),
      );
      await expect(page).toHaveScreenshot(`studio-${name}-${width}.png`, {
        animations: 'disabled',
        caret: 'hide',
        fullPage: true,
      });
    });
