import { expect, test } from '@playwright/test';
import {
  DANGER_TEXT,
  errorColour,
  expectAccessible,
  fitsViewport,
  identity,
  signInWithEmail,
} from './helpers';

async function claimNewPage(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  { skipMoment = true, handle }: { skipMoment?: boolean; handle?: string } = {},
) {
  const who = { ...identity(testInfo), ...(handle ? { handle } : {}) };
  await signInWithEmail(page, who.email, '/sign-up');
  await expect(
    page
      .getByRole('list', { name: 'Creating your page' })
      .locator('[aria-current="step"]'),
  ).toHaveText('Your handle');
  await page.getByLabel('Handle').fill(who.handle);
  await expect(page.getByText(`@${who.handle} is available`)).toBeVisible();
  await page.getByRole('button', { name: `Claim @${who.handle}` }).click();
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

test('claiming a handle celebrates once: "@handle is yours.", then the hello step', async ({
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
  await expect(
    moment.getByRole('heading', { name: `@${handle} is yours.` }),
  ).toBeFocused();
  await expect(
    moment.getByText(
      'Welcome to TipMe. People can start thanking you the moment your page is online.',
    ),
  ).toBeVisible();
  await expect(moment.getByRole('status')).toHaveText(
    `Your handle @${handle} is claimed. Welcome to TipMe.`,
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
  // Axe runs on the moment in the still test: mid-fade text would read as low contrast here.
  await page.screenshot({ path: testInfo.outputPath('claim-moment.png') });

  // It hands over by itself, and focus lands on the hello heading.
  const hello = page.getByRole('heading', { name: 'Welcome to TipMe.' });
  await expect(hello).toBeFocused({ timeout: 3000 });
  await expect(moment).toHaveCount(0);
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

for (const how of ['Escape', 'Continue'] as const)
  test(`${how} skips the moment at once`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Time runs normally until the moment shows; then it stops, so only the key or the button can
    // end it, never the 1.6 s timer.
    await page.clock.install();
    const { handle } = await claimNewPage(page, testInfo, {
      skipMoment: false,
    });
    const moment = page.getByRole('dialog', { name: `@${handle} is yours.` });
    await expect(moment).toBeVisible();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
    await page.waitForTimeout(2000);
    await expect(moment).toBeVisible();
    if (how === 'Escape') await page.keyboard.press('Escape');
    else await moment.getByRole('button', { name: 'Continue' }).click();
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
  // The same hand-over, and still no vibration.
  await expect(
    page.getByRole('heading', { name: 'Welcome to TipMe.' }),
  ).toBeFocused({ timeout: 3000 });
  expect(await buzzes(page)).toEqual([]);
});

test('someone who presses "I’ll do this later" was still celebrated first', async ({
  page,
}, testInfo) => {
  const { handle } = await claimNewPage(page, testInfo, {
    skipMoment: false,
  });
  await expect(
    page.getByRole('heading', { name: `@${handle} is yours.` }),
  ).toBeVisible();
  // Any tap hands over.
  await page.mouse.click(10, 10);
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

test('the moment fits a 320px phone @mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  // The longest handle there is: 30 characters.
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
  await page.getByRole('link', { name: 'Go to my dashboard' }).click();
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
  await page.getByRole('link', { name: 'Go to my dashboard' }).click();
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
    .filter({ hasText: 'We couldn’t save that.' });
  await expect(line).toBeVisible();
  expect(await errorColour(line)).toBe(DANGER_TEXT);
});
