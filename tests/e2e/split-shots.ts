import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';

/**
 * Phone and desktop screenshots for a PR body (per-provider balances, Task 9), only when
 * SPLIT_SHOTS_DIR is set. They are never baselines: nothing compares against them.
 *
 * Each width is a fresh load (the layout is the one that width gets), then `prepare` brings the
 * screen back to the state to show. The skip link is hidden, the tab bar sits in the flow instead
 * of over the page, and the live stream answers 204 so no toast appears. `target`: a part of a long
 * page to show instead of the whole of it.
 */
export const SHOTS_DIR = process.env['SPLIT_SHOTS_DIR'];

const STYLE =
  '.skip-link{display:none!important}' +
  '.dashboard-page .dashboard-nav[aria-label=Dashboard]{position:static!important}';

export async function shoot(
  page: Page,
  name: string,
  prepare: () => Promise<void> = async () => undefined,
  target?: Locator,
) {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.route('**/v1/me/events', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  const size = page.viewportSize();
  for (const [label, width] of [
    ['phone', 390],
    ['desktop', 1440],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await prepare();
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    const options = {
      path: join(SHOTS_DIR, `${name}-${label}-${width}.png`),
      caret: 'hide',
      animations: 'disabled',
      style: STYLE,
    } as const;
    if (target) await target.screenshot(options);
    else await page.screenshot({ ...options, fullPage: true });
  }
  // Back as the test had it, for anything that follows.
  if (size) await page.setViewportSize(size);
  await page.reload();
  await prepare();
}
