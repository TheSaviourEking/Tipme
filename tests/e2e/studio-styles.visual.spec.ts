import { expect, test } from '@playwright/test';

// Each new style's lab example at a phone and a wide desktop, light (spec 2026-11-17-page-studio-
// styles §14.4). Linux CI is the authority for these images: the Linux baselines come only from a
// CI run's artifacts. The Darwin copies are for local runs (as profile.visual).
const SHOTS = [
  ['clear', 390],
  ['clear', 1440],
] as const;

for (const [style, width] of SHOTS)
  test(`${style[0]!.toUpperCase()}${style.slice(1)} at ${width} light`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/dev/studio-lab?style=${style}&mode=light`);
    await page.locator('.studio[data-style]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    // The tip form has started and its observer has placed the phone's bar (data-bar).
    await page
      .locator('form[data-skin][data-bar]')
      .waitFor({ state: 'attached' });
    // Photos are generated SVGs; wait for every one in view so the capture is stable.
    await page.waitForFunction(() =>
      [...document.images].every((i) => i.loading === 'lazy' || i.complete),
    );
    await expect(page).toHaveScreenshot(`studio-${style}-${width}-light.png`, {
      animations: 'disabled',
      caret: 'hide',
      fullPage: true,
    });
  });
