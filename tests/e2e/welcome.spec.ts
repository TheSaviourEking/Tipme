import { expect, test } from '@playwright/test';
import {
  DANGER_TEXT,
  errorColour,
  expectAccessible,
  fitsViewport,
  identity,
  signInWithEmail,
} from './helpers';
import { CONNECTION_COPY } from '../../apps/web/src/lib/connection-copy';

async function claimNewPage(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  {
    skipMoment = true,
    handle,
    byKeyboard = false,
  }: { skipMoment?: boolean; handle?: string; byKeyboard?: boolean } = {},
) {
  const who = { ...identity(testInfo), ...(handle ? { handle } : {}) };
  await signInWithEmail(page, who.email, '/sign-up');
  await expect(
    page
      .getByRole('list', { name: 'Creating your page' })
      .locator('[aria-current="step"]'),
  ).toHaveText('Your username');
  await page.getByLabel('Username').fill(who.handle);
  await expect(page.getByText(`@${who.handle} is available`)).toBeVisible();
  const claim = page.getByRole('button', { name: `Claim @${who.handle}` });
  if (byKeyboard) {
    await claim.focus();
    await page.keyboard.press('Enter');
  } else await claim.click();
  await page.waitForURL(/\/dashboard\/welcome$/);
  // The claim moment plays once; most tests here are about the steps after it.
  if (skipMoment)
    await page
      .getByRole('dialog', { name: `@${who.handle} is yours.` })
      .getByRole('button', { name: 'Continue' })
      .click();
  return who;
}

/** Records navigator.vibrate calls in window.__buzz, before any page script runs. */
async function recordVibration(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as unknown as { __buzz: unknown[] }).__buzz = calls;
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: unknown) => (calls.push(pattern), true),
    });
  });
}
const buzzes = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __buzz: unknown[] }).__buzz);

/** The drawn focus ring of an element: 'none' unless an outline shows. */
const ring = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return style.outlineStyle === 'none' || style.outlineWidth === '0px'
      ? 'none'
      : `${style.outlineWidth} ${style.outlineStyle}`;
  });

test('claiming a username celebrates once: "@username is yours." stays until Continue, then the hello step', async ({
  page,
}, testInfo) => {
  // The full scene, as most people see it (the suite otherwise runs with reduced motion).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await recordVibration(page);
  const { handle } = await claimNewPage(page, testInfo, {
    skipMoment: false,
  });
  const moment = page.getByRole('dialog', { name: `@${handle} is yours.` });
  await expect(moment).toBeVisible();
  const title = moment.getByRole('heading', { name: `@${handle} is yours.` });
  // Screen readers land on the heading, but it is not a control: no purple box around it.
  await expect(title).toBeFocused();
  expect(await ring(title)).toBe('none');
  await expect(
    moment.getByText(
      'Welcome to TipMe. People can start tipping you the moment your page is online.',
    ),
  ).toBeVisible();
  await expect(moment.getByRole('status')).toHaveText(
    `Your username @${handle} is claimed. Welcome to TipMe.`,
  );
  // The card, stamp and hearts are pictures only.
  const scene = page.locator('.claim-moment__scene');
  await expect(scene).toHaveAttribute('aria-hidden', 'true');
  await expect(scene.locator('.claim-moment__stamp')).toHaveText(
    `@${handle} · YOURS`,
  );
  await expect(scene.locator('.claim-moment__card')).toContainText(
    `/@${handle}`,
  );
  await expect(scene.locator('.claim-moment__heart')).toHaveCount(6);
  expect(
    await scene
      .locator('.claim-moment__stamp')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).not.toBe('none');
  // Axe runs on the moment in the still test: mid-animation text would read as low contrast here.

  // It stays: well past the old 1.6 s it is still there, whole, with focus where it was.
  await page.waitForTimeout(2500);
  await expect(moment).toBeVisible();
  expect(
    await moment.evaluate((el) => Number(getComputedStyle(el).opacity)),
  ).toBe(1);
  await expect(title).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('claim-moment.png') });

  // Continue hands over; focus lands on the hello heading with no ring flashing there.
  await moment.getByRole('button', { name: 'Continue' }).click();
  const hello = page.getByRole('heading', { name: 'Welcome to TipMe.' });
  await expect(hello).toBeFocused();
  await expect(moment).toHaveCount(0);
  expect(await ring(hello)).toBe('none');
  expect(await buzzes(page)).toEqual([30]);
  await expectAccessible(page);

  // Never again: not on reload.
  await page.reload();
  await expect(hello).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: `@${handle} is yours.` }),
  ).toHaveCount(0);
});

for (const how of ['Escape', 'Enter'] as const)
  test(`${how} ends the moment`, async ({ page }, testInfo) => {
    const { handle } = await claimNewPage(page, testInfo, {
      skipMoment: false,
    });
    const moment = page.getByRole('dialog', { name: `@${handle} is yours.` });
    await expect(moment).toBeVisible();
    await expect(
      moment.getByRole('heading', { name: `@${handle} is yours.` }),
    ).toBeFocused();
    await page.keyboard.press(how);
    await expect(moment).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Welcome to TipMe.' }),
    ).toBeFocused();
  });

test('Tab moves focus inside the moment and never ends it or leaves it', async ({
  page,
}, testInfo) => {
  const { handle } = await claimNewPage(page, testInfo, {
    skipMoment: false,
    byKeyboard: true,
  });
  const moment = page.getByRole('dialog', { name: `@${handle} is yours.` });
  const next = moment.getByRole('button', { name: 'Continue' });
  await expect(moment).toBeVisible();
  // Claimed from the keyboard, the heading still gets no ring: it is somewhere to read, not a
  // control.
  const title = moment.getByRole('heading', { name: `@${handle} is yours.` });
  await expect(title).toBeFocused();
  expect(await ring(title)).toBe('none');
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  // Continue is the only control, so Tab and Shift+Tab come back round to it.
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(next).toBeFocused();
  // Other keys change nothing either.
  await page.keyboard.press('a');
  await expect(moment).toBeVisible();
  // From the keyboard, the control shows its ring.
  expect(await ring(next)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(moment).toHaveCount(0);
});

test('the tap that claimed is not a tap to move on; a tap once the card is down is', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Time stops right after the moment shows, so the card has not landed when we tap.
  await page.clock.install();
  const { handle } = await claimNewPage(page, testInfo, {
    skipMoment: false,
  });
  const moment = page.getByRole('dialog', { name: `@${handle} is yours.` });
  await expect(moment).toBeVisible();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  await page.mouse.click(10, 10);
  await expect(moment).toBeVisible();
  // Once the card is down, a tap anywhere is a choice to move on.
  await page.clock.runFor(1000);
  await expect(moment).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(moment).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Welcome to TipMe.' }),
  ).toBeFocused();
});

test('reduced motion shows the still scene with no animation', async ({
  page,
}, testInfo) => {
  // The suite's default: prefers-reduced-motion is reduce.
  await recordVibration(page);
  const { handle } = await claimNewPage(page, testInfo, {
    skipMoment: false,
  });
  const moment = page.getByRole('dialog', { name: `@${handle} is yours.` });
  await expect(moment).toBeVisible();
  await expect(moment).toHaveClass(/claim-moment--still/);
  const scene = page.locator('.claim-moment__scene');
  await expect(scene.locator('.claim-moment__heart')).toHaveCount(3);
  for (const part of [
    '.claim-moment__card',
    '.claim-moment__stamp',
    '.claim-moment__heart',
  ])
    expect(
      await scene
        .locator(part)
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
  await expect(scene.locator('.claim-moment__stamp')).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({
    path: testInfo.outputPath('claim-moment-still.png'),
  });
  // It stays here too; Continue hands over the same way, still with no vibration.
  await page.waitForTimeout(2000);
  await expect(moment).toBeVisible();
  await moment.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('heading', { name: 'Welcome to TipMe.' }),
  ).toBeFocused();
  expect(await buzzes(page)).toEqual([]);
});

test('someone who presses "I’ll do this later" was still celebrated first', async ({
  page,
}, testInfo) => {
  const { handle } = await claimNewPage(page, testInfo, {
    skipMoment: false,
  });
  const moment = page.getByRole('dialog', { name: `@${handle} is yours.` });
  await expect(moment).toBeVisible();
  await moment.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: 'I’ll do this later' }).click();
  await page.waitForURL(/\/dashboard$/);
  await page.goBack();
  await page.waitForURL(/\/dashboard\/welcome$/);
  await expect(
    page.getByRole('heading', { name: 'Welcome to TipMe.' }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/** The stamp's box must not cover the amounts or the Tip button's words, and stays on the card. */
async function expectStampClear(page: import('@playwright/test').Page) {
  const boxes = await page.evaluate(() => {
    const box = (r: DOMRect) => ({
      x: r.left,
      y: r.top,
      right: r.right,
      bottom: r.bottom,
    });
    const card = document.querySelector('.claim-moment__card')!;
    // The words of the Tip button, not the whole black bar.
    const words = document.createRange();
    words.selectNodeContents(card.querySelector('.claim-moment__tip')!);
    return {
      stamp: box(
        card.querySelector('.claim-moment__stamp')!.getBoundingClientRect(),
      ),
      keys: [...card.querySelectorAll('.claim-moment__keys > span')].map((k) =>
        box(k.getBoundingClientRect()),
      ),
      tip: box(words.getBoundingClientRect()),
      card: box(card.getBoundingClientRect()),
    };
  });
  type Box = { x: number; y: number; right: number; bottom: number };
  const overlaps = (a: Box, b: Box) =>
    a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
  expect(boxes.keys.length).toBeGreaterThan(0);
  for (const key of boxes.keys) expect(overlaps(boxes.stamp, key)).toBe(false);
  expect(overlaps(boxes.stamp, boxes.tip)).toBe(false);
  expect(boxes.stamp.x).toBeGreaterThanOrEqual(boxes.card.x);
  expect(boxes.stamp.right).toBeLessThanOrEqual(boxes.card.right);
}

for (const width of [390, 1440])
  test(`the stamp sits clear of the amounts and the Tip button at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    // The longest username there is: 30 characters.
    const handle = `${identity(testInfo).handle}_${'x'.repeat(30)}`.slice(
      0,
      30,
    );
    await claimNewPage(page, testInfo, { skipMoment: false, handle });
    await expect(
      page.getByRole('dialog', { name: `@${handle} is yours.` }),
    ).toBeVisible();
    await expectStampClear(page);
  });

test('the moment fits a 320px phone @mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  // The longest username there is: 30 characters.
  const handle = `${identity(testInfo).handle}_${'x'.repeat(30)}`.slice(0, 30);
  await claimNewPage(page, testInfo, { skipMoment: false, handle });
  const moment = page.getByRole('dialog', { name: `@${handle} is yours.` });
  await expect(moment).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  const title = await moment
    .getByRole('heading', { name: `@${handle} is yours.` })
    .boundingBox();
  const stamp = await page.locator('.claim-moment__stamp').boundingBox();
  expect(title && stamp).toBeTruthy();
  // The stamp sits on the card, clear of the heading below it.
  expect(stamp!.y + stamp!.height).toBeLessThanOrEqual(title!.y);
  expect(title!.x).toBeGreaterThanOrEqual(0);
  expect(title!.x + title!.width).toBeLessThanOrEqual(320);
  await expectStampClear(page);
  await expectAccessible(page);
  await page.screenshot({
    path: testInfo.outputPath('claim-moment-320.png'),
  });
});

test('a new recipient is welcomed and sets up their page one small step at a time', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await claimNewPage(page, testInfo);
  await expect(
    page.getByRole('heading', { name: 'Welcome to TipMe.' }),
  ).toBeVisible();
  await expect(page.getByText(`@${handle} is yours now.`)).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({ path: testInfo.outputPath('welcome-hello.png') });

  await page.getByRole('button', { name: 'Let’s set up your page' }).click();
  const nameHeading = page.getByRole('heading', {
    name: 'What should people call you?',
  });
  await expect(nameHeading).toBeFocused();
  await page.getByLabel('Your name').fill('Kemi Bello');
  await page.getByLabel('What you do').fill('Hairdresser at Glow Studio');
  // The preview follows what they type before anything is saved.
  await expect(
    page.getByRole('complementary', { name: 'Preview of your page' }),
  ).toContainText('Kemi Bello');
  await expectAccessible(page);
  await page.screenshot({ path: testInfo.outputPath('welcome-about.png') });
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(
    page.getByRole('heading', { name: /Nice to meet you, Kemi\./ }),
  ).toBeFocused();
  await page
    .getByLabel('A line about you', { exact: true })
    .fill('Braids and kindness.');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(
    page.getByRole('heading', { name: 'Ready to put your page online?' }),
  ).toBeFocused();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Make my page live' }).click();

  await expect(
    page.getByRole('heading', { name: 'You’re all set, Kemi.' }),
  ).toBeVisible();
  await expect(page.getByText(/Your page is live\./)).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({ path: testInfo.outputPath('welcome-done.png') });
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Go to my dashboard' })
    .click();
  await page.waitForURL(/\/dashboard$/);
  await expect(
    page.getByRole('heading', { name: 'Your page is ready to share' }),
  ).toBeVisible();
  await expect(page.getByText('Make your page feel like you')).toBeVisible();
  await expect(page.getByText('Done', { exact: true })).toBeVisible();
  await expect(page.getByText('Put your page online')).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Share your link or QR', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Set up payments and payouts')).toBeVisible();
  await expect(page.getByText('Coming later', { exact: true })).toBeVisible();

  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(
      'Kemi Bello',
      { timeout: 1000 },
    );
  }).toPass({ timeout: 5000 });
  await expect(visitor.getByText('Hairdresser at Glow Studio')).toBeVisible();
  await expect(visitor.getByText('Braids and kindness.')).toBeVisible();
});

test('every welcome step can be skipped, and nothing goes live without asking', async ({
  page,
}, testInfo) => {
  await claimNewPage(page, testInfo);
  await page.getByRole('button', { name: 'Let’s set up your page' }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Not yet' }).click();
  await expect(
    page.getByRole('heading', { name: 'You’re set up.' }),
  ).toBeVisible();
  await expect(page.getByText(/not online yet/)).toBeVisible();
  await page
    .getByRole('main')
    .getByRole('link', { name: 'Go to my dashboard' })
    .click();
  await page.waitForURL(/\/dashboard$/);
  await expect(
    page.getByRole('heading', { name: 'Get your page ready to share' }),
  ).toBeVisible();
  // The first-day dashboard reaches page settings from the page card (Task 10's "Edit page").
  await expect(page.getByRole('link', { name: 'Edit page' })).toHaveAttribute(
    'href',
    '/dashboard/settings',
  );
});

test(
  'sign-up and the welcome reflow on a small phone',
  { tag: '@mobile' },
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Narrow viewport only.');
    await page.goto('/sign-up');
    expect(await fitsViewport(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('sign-up-mobile.png'),
      fullPage: true,
    });
    await claimNewPage(page, testInfo);
    expect(await fitsViewport(page)).toBe(true);
    await page.getByRole('button', { name: 'Let’s set up your page' }).click();
    await page.setViewportSize({ width: 320, height: 720 });
    expect(await fitsViewport(page)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('welcome-about-mobile.png'),
      fullPage: true,
    });
  },
);

// PR A review I2: these lines sit below the fields, not inside one with a red edge, so they keep
// their red until the dashboard batch restyles them.
test('a welcome save that fails keeps its error line red', async ({
  page,
}, testInfo) => {
  await claimNewPage(page, testInfo);
  await page.route('**/v1/me/profile', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'x' } },
        })
      : route.fallback(),
  );
  await page.getByRole('button', { name: 'Let’s set up your page' }).click();
  await page.getByLabel('Your name').fill('Kemi Bello');
  await page.getByRole('button', { name: 'Continue' }).click();
  const line = page
    .getByRole('alert')
    .filter({ hasText: CONNECTION_COPY.ourSide });
  await expect(line).toBeVisible();
  expect(await errorColour(line)).toBe(DANGER_TEXT);
});

// States plan, Task 16: the welcome PATCH is safe to repeat, so a dropped one is tried again.
test('a dropped save is retried once quietly', async ({ page }, testInfo) => {
  await claimNewPage(page, testInfo);
  let patches = 0;
  await page.route('**/v1/me/profile', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patches += 1;
    return patches === 1 ? route.abort() : route.fallback();
  });
  await page.getByRole('button', { name: 'Let’s set up your page' }).click();
  await page.getByLabel('Your name').fill('Kemi Bello');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('textbox', { name: 'A line about you' }),
  ).toBeVisible();
  // No failure was shown (Next's route announcer is an alert region too, so look for the line).
  await expect(page.locator('.tm-field-error')).toHaveCount(0);
  expect(patches).toBe(2);
});

test('a save dropped twice says to tap Continue', async ({
  page,
}, testInfo) => {
  await claimNewPage(page, testInfo);
  await page.route('**/v1/me/profile', (route) =>
    route.request().method() === 'PATCH' ? route.abort() : route.fallback(),
  );
  await page.getByRole('button', { name: 'Let’s set up your page' }).click();
  await page.getByLabel('Your name').fill('Kemi Bello');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: CONNECTION_COPY.welcomeDropped }),
  ).toBeVisible();
});
