import { expect, test, type Page } from '@playwright/test';
import { signUpRecipient } from './helpers';
import { sql } from './ops-helpers';

// Animated covers (owner's exception, EXPERIENCE-AND-MOTION 7.11): the real page in a real browser.
// The suite runs with reduced motion by default, so each motion test asks for it explicitly.
const COVER = '.profile-cover';

type Seed = {
  animation: string;
  plan?: 'free' | 'pro';
  motion?: 'once' | 'loop';
  colour?: string;
};

/** A new live page with an animated cover chosen straight in the database, then opened. */
async function openAnimated(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
  seed: Seed,
  { reducedMotion = 'no-preference' as 'no-preference' | 'reduce' } = {},
) {
  const who = await signUpRecipient(page, testInfo);
  await sql(
    `UPDATE profiles SET cover_animation = $2, cover_motion = $3, cover_colour = $4, plan = $5
       WHERE handle_lower = $1`,
    [
      who.handle.toLowerCase(),
      seed.animation,
      seed.motion ?? null,
      seed.colour ?? null,
      seed.plan ?? 'free',
    ],
  );
  await page.emulateMedia({ reducedMotion });
  await page.goto(`/@${who.handle}`);
  await page.locator(COVER).waitFor();
  return who;
}

const animations = (page: Page) =>
  page.locator(COVER).evaluate((el) =>
    el.getAnimations({ subtree: true }).map((a) => ({
      state: a.playState,
      time: Number(a.currentTime ?? 0),
      iterations: a.effect?.getComputedTiming().iterations ?? 0,
    })),
  );

test('a Free animated cover plays once and settles @mobile', async ({
  page,
}, testInfo) => {
  await openAnimated(page, testInfo, { animation: 'drift' });
  await expect(page.locator(COVER)).toHaveAttribute('data-cover-play', 'once');
  expect((await animations(page)).length).toBe(5);
  await expect
    .poll(
      async () => (await animations(page)).every((a) => a.state === 'finished'),
      { timeout: 6_000 },
    )
    .toBe(true);
});

test('a Pro slow loop keeps running', async ({ page }, testInfo) => {
  await openAnimated(page, testInfo, {
    animation: 'night',
    plan: 'pro',
    motion: 'loop',
  });
  await expect(page.locator(COVER)).toHaveAttribute('data-cover-play', 'loop');
  await page.waitForTimeout(4_000);
  const now = await animations(page);
  expect(now.some((a) => a.state === 'running')).toBe(true);
  expect(now.every((a) => a.iterations === Infinity)).toBe(true);
});

test('focusing the tip form freezes the cover, and it stays frozen @mobile', async ({
  page,
}, testInfo) => {
  await openAnimated(page, testInfo, {
    animation: 'night',
    plan: 'pro',
    motion: 'loop',
  });
  await page.getByRole('radio', { name: '2,000 NGN' }).focus();
  await expect(page.locator(COVER)).toHaveAttribute('data-cover-frozen', '');
  await expect
    .poll(async () =>
      (await animations(page)).every((a) => a.state === 'paused'),
    )
    .toBe(true);
  const held = (await animations(page)).map((a) => a.time);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.waitForTimeout(1_000);
  const after = await animations(page);
  expect(after.every((a) => a.state === 'paused')).toBe(true);
  expect(after.map((a) => a.time)).toEqual(held);
});

test('typing an amount, or tapping Tip, freezes it too', async ({
  page,
}, testInfo) => {
  const who = await openAnimated(page, testInfo, {
    animation: 'night',
    plan: 'pro',
    motion: 'loop',
  });
  const cover = page.locator(COVER);
  const panel = page.locator('[data-tip-panel]');
  await expect(cover).not.toHaveAttribute('data-cover-frozen', '');
  // Each kind of first touch on its own, on a fresh view of the page.
  await panel
    .getByRole('button', { name: /^Tip\b/ })
    .dispatchEvent('pointerdown');
  await expect(cover).toHaveAttribute('data-cover-frozen', '');
  await page.goto(`/@${who.handle}`);
  await expect(cover).not.toHaveAttribute('data-cover-frozen', '');
  await panel.dispatchEvent('input');
  await expect(cover).toHaveAttribute('data-cover-frozen', '');
  await page.goto(`/@${who.handle}`);
  await page
    .getByLabel(/^Other amount/)
    .first()
    .fill('3500');
  await expect(cover).toHaveAttribute('data-cover-frozen', '');
});

test('scrolling the cover off screen pauses it; scrolling back resumes a loop', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await openAnimated(page, testInfo, {
    animation: 'night',
    plan: 'pro',
    motion: 'loop',
  });
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(COVER)).toHaveAttribute('data-cover-offscreen', '');
  await expect
    .poll(async () =>
      (await animations(page)).every((a) => a.state === 'paused'),
    )
    .toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator(COVER)).not.toHaveAttribute(
    'data-cover-offscreen',
    '',
  );
  await expect
    .poll(async () =>
      (await animations(page)).some((a) => a.state === 'running'),
    )
    .toBe(true);
});

test('reduced motion shows the still frame with no animations', async ({
  page,
}, testInfo) => {
  const who = await openAnimated(
    page,
    testInfo,
    { animation: 'rise' },
    { reducedMotion: 'reduce' },
  );
  expect((await animations(page)).length).toBe(0);
  const settled = () =>
    page.locator('.cover-fx').evaluateAll((els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        // A finished animation reports its identity transform as a matrix, a still layer as none.
        const matrix = new DOMMatrix(
          style.transform === 'none' ? undefined : style.transform,
        );
        return `${matrix.toString()}|${style.opacity}`;
      }),
    );
  const still = await settled();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`/@${who.handle}`);
  await expect
    .poll(
      async () => (await animations(page)).every((a) => a.state === 'finished'),
      {
        timeout: 6_000,
      },
    )
    .toBe(true);
  expect(await settled()).toEqual(still);
});

test('forced colours show the still frame', async ({ page }, testInfo) => {
  await page.emulateMedia({
    forcedColors: 'active',
    reducedMotion: 'no-preference',
  });
  await openAnimated(page, testInfo, {
    animation: 'night',
    plan: 'pro',
    motion: 'loop',
  });
  await page.emulateMedia({
    forcedColors: 'active',
    reducedMotion: 'no-preference',
  });
  await page.reload();
  expect((await animations(page)).length).toBe(0);
});

test('a page that left Pro shows the still frame', async ({
  page,
}, testInfo) => {
  await openAnimated(page, testInfo, {
    animation: 'night',
    plan: 'free',
    motion: 'loop',
  });
  await expect(page.locator(COVER)).toHaveAttribute('data-cover-play', 'still');
  expect((await animations(page)).length).toBe(0);
});

test('nothing is written on the cover', async ({ page }, testInfo) => {
  await openAnimated(page, testInfo, { animation: 'drift' });
  const inside = await page.locator(COVER).evaluate((el) => ({
    text: el.textContent?.trim() ?? '',
    focusable: el.querySelectorAll(
      'a, button, input, select, textarea, [tabindex]',
    ).length,
  }));
  expect(inside).toEqual({ text: '', focusable: 0 });
});
