import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  identity,
  signInWithEmail,
} from './helpers';

async function claimNewPage(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
) {
  const who = identity(testInfo);
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
  return who;
}

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
    page.getByRole('figure', { name: 'Preview of your page' }),
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
  await expect(page.getByRole('link', { name: 'Page settings' })).toBeVisible();
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
