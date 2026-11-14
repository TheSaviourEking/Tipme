import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';

// Campaign pages (plan 2026-11-14 Task 8; board ProCampaignPages sections 2 and 3). Each test has
// its own page and its own link ending; Pro is set in the database (no staff are made).

type Info = Parameters<typeof signUpRecipient>[1] & { workerIndex: number };
const endingFor = (testInfo: Info) =>
  `c${testInfo.workerIndex}${Date.now().toString(36)}`;

async function recipient(page: Page, testInfo: Info, plan: 'pro' | 'free') {
  const { handle } = await signUpRecipient(page, testInfo);
  await sql(
    `UPDATE profiles SET display_name = 'Kemi Adisa', plan = $2 WHERE handle_lower = $1`,
    [handle, plan],
  );
  return handle;
}

/** Makes a campaign through Campaign Studio and lands on its page. */
async function newCampaign(page: Page, name: string, ending: string) {
  await page.goto('/dashboard/campaigns/new');
  const main = page.getByRole('main');
  await main.getByLabel('Name').fill(name);
  await main.getByLabel('Link').fill(ending);
  await main.getByRole('button', { name: 'Create campaign' }).click();
  await page.waitForURL(/\/dashboard\/campaigns\/[0-9a-f-]{36}$/);
  await expect(main.getByRole('heading', { name, level: 1 })).toBeVisible();
  return main;
}

/** A visitor's own browser opens the link, retrying while the web warms up. */
async function visit(
  browser: Browser,
  path: string,
  ready: (page: Page) => Promise<void>,
) {
  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(path);
    await ready(visitor);
  }).toPass({ timeout: 20_000 });
  return visitor;
}

const tipArea = (page: Page) => page.locator('aside[aria-label^="Tip"]');

test('Pro edits a campaign page and a visitor sees it with the same tip area', async ({
  page,
  browser,
}, testInfo) => {
  const handle = await recipient(page, testInfo, 'pro');
  const ending = endingFor(testInfo);
  const main = await newCampaign(page, 'Lagos Live', ending);
  const panel = main.getByRole('tabpanel');
  await expect(
    main.getByRole('tab', { name: 'Page', selected: true }),
  ).toBeVisible();
  const headline = 'Thank you for dancing with me at Lagos Live';
  await panel.getByLabel('Headline').fill(headline);
  await expect(panel.getByText('43 of 60.', { exact: false })).toBeVisible();
  await panel
    .getByLabel('Short description (optional)')
    .fill('Saturday at the park. Put a song request in your message.');
  await expect(
    panel.getByRole('region', { name: 'Live preview' }).getByText(headline),
  ).toBeVisible();
  await expectAccessible(page);
  await panel.getByRole('button', { name: 'Save page' }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'Saved' }),
  ).toBeVisible();

  const visitor = await visit(browser, `/@${handle}/${ending}`, async (v) => {
    await expect(
      v.getByRole('main').getByRole('heading', { name: headline, level: 2 }),
    ).toBeVisible({ timeout: 2000 });
  });
  const visitorMain = visitor.getByRole('main');
  await expect(
    visitorMain.getByRole('heading', { name: 'Kemi Adisa', level: 1 }),
  ).toBeVisible();
  await expect(
    tipArea(visitor).getByRole('radio', { name: '2,000 NGN' }),
  ).toBeVisible();
  const mainLink = visitorMain.getByRole('link', {
    name: 'See Kemi’s main page',
  });
  await expect(mainLink).toHaveAttribute('href', `/@${handle}`);
  await expectAccessible(visitor);
  await visitor.context().close();
});

test('the campaign page asks search engines not to index it', async ({
  page,
  browser,
}, testInfo) => {
  const handle = await recipient(page, testInfo, 'pro');
  const ending = endingFor(testInfo);
  // A new Pro campaign starts with its own page, its name as the headline.
  await newCampaign(page, 'Studio day', ending);
  const visitor = await visit(browser, `/@${handle}/${ending}`, async (v) => {
    await expect(
      v
        .getByRole('main')
        .getByRole('heading', { name: 'Studio day', level: 2 }),
    ).toBeVisible({ timeout: 2000 });
  });
  await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    /noindex/,
  );
  await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    /(^|,\s*)follow/,
  );
  const canonical = await visitor
    .locator('link[rel="canonical"]')
    .getAttribute('href');
  expect(canonical).toMatch(new RegExp(`/@${handle}$`));
  await visitor.context().close();
});

test('a stopped campaign’s link opens the main page', async ({
  page,
  browser,
}, testInfo) => {
  const handle = await recipient(page, testInfo, 'pro');
  const ending = endingFor(testInfo);
  const main = await newCampaign(page, 'Pop-up', ending);
  // Seen once while it runs, so the stop has a cached page to replace.
  const visitor = await visit(browser, `/@${handle}/${ending}`, async (v) => {
    await expect(
      v.getByRole('main').getByRole('heading', { name: 'Pop-up', level: 2 }),
    ).toBeVisible({ timeout: 2000 });
  });
  await main.getByRole('tab', { name: 'Results' }).click();
  await main.getByRole('button', { name: 'Stop this campaign' }).click();
  await expect(main.getByText(/^Stopped /)).toBeVisible();
  await expect(async () => {
    await visitor.goto(`/@${handle}/${ending}`);
    await expect(
      tipArea(visitor).getByRole('radio', { name: '2,000 NGN' }),
    ).toBeVisible({ timeout: 2000 });
    await expect(
      visitor
        .getByRole('main')
        .getByRole('heading', { level: 2, name: 'Pop-up' }),
    ).toHaveCount(0);
  }).toPass({ timeout: 15_000 });
  await visitor.context().close();
});

test('Free sees the Page tab locked', async ({ page }, testInfo) => {
  await recipient(page, testInfo, 'free');
  const main = await newCampaign(page, 'Market day', endingFor(testInfo));
  const panel = main.getByRole('tabpanel');
  await expect(
    panel.getByText('Give each campaign its own page', { exact: false }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save page' })).toHaveCount(0);
  await expect(panel.getByLabel('Headline')).toBeDisabled();
  await expectAccessible(page);
});

test('the new-campaign copy no longer says no goal on Pro', async ({
  page,
}, testInfo) => {
  await recipient(page, testInfo, 'pro');
  await page.goto('/dashboard/campaigns/new');
  const about = page
    .getByRole('main')
    .locator('section, div')
    .filter({
      has: page.getByRole('heading', { name: 'What a campaign is, and isn’t' }),
    })
    .last();
  await expect(
    about.getByText('Its own page, if you want one.', { exact: false }),
  ).toBeVisible();
  await expect(
    about.getByText('No goal, no target amount', { exact: false }),
  ).toHaveCount(0);
});
