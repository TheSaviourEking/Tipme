import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';

/**
 * Phone and desktop screenshots for a PR body (per-provider balances, Task 9), only when
 * SPLIT_SHOTS_DIR is set. They are never baselines: nothing compares against them.
 *
 * Each width is a fresh load (the layout is the one that width gets), then `prepare` brings the
 * screen back to the state to show. The skip link and the phone's fixed tab bar are hidden (in a
 * full-page shot the bar would sit over the middle of the page), and the live stream answers 204
 * so no toast appears. `target`: a part of a long page to show instead of the whole of it, with
 * 24px of the page around it.
 */
export const SHOTS_DIR = process.env['SPLIT_SHOTS_DIR'];
const PAD = 24;

const STYLE =
  '.skip-link{display:none!important}' +
  // A tip's toast (notification-bell.tsx), for shots that keep the live stream.
  '.toast-region .toast{display:none!important}';
/**
 * On a phone the Dashboard nav is the fixed tab bar, which a full-page shot would draw over the
 * middle of the page; on a desktop it is the menu at the top, and stays.
 */
const styleFor = (width: number) =>
  width < 600
    ? `${STYLE}.dashboard-page .dashboard-nav[aria-label=Dashboard]{display:none!important}`
    : STYLE;

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
      caret: 'hide' as const,
      animations: 'disabled' as const,
      style: styleFor(width),
    };
    if (target) {
      // Page coordinates, read in one go: a full-page shot clipped to the box with 24px of room
      // on every side, the first child's top margin included.
      const box = await target.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const first = el.firstElementChild;
        const above = first
          ? Math.max(
              0,
              rect.top - first.getBoundingClientRect().top,
              parseFloat(getComputedStyle(first).marginTop) || 0,
            )
          : 0;
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY - above,
          width: rect.width,
          height: rect.height + above,
          pageWidth: document.documentElement.scrollWidth,
        };
      });
      const x = Math.max(0, box.x - PAD);
      const y = Math.max(0, box.y - PAD);
      await page.screenshot({
        ...options,
        fullPage: true,
        clip: {
          x,
          y,
          width: Math.min(box.width + 2 * PAD, box.pageWidth - x),
          height: box.height + 2 * PAD,
        },
      });
    } else await page.screenshot({ ...options, fullPage: true });
  }
  // Back as the test had it, for anything that follows.
  if (size) await page.setViewportSize(size);
  await page.reload();
  await prepare();
}

/**
 * One shot of the page as it is now, at the width the test already loaded it at: for a state that
 * only a real action reaches (a receipt after a real withdrawal), so it can't be loaded again. The
 * live stream is left alone, so the page shows what it refreshed to.
 */
export async function snap(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  const label = width < 600 ? 'phone' : 'desktop';
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.screenshot({
    path: join(SHOTS_DIR, `${name}-${label}-${width}.png`),
    fullPage: true,
    caret: 'hide',
    animations: 'disabled',
    style: styleFor(width),
  });
}
