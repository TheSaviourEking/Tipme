import type { Page } from '@playwright/test';

/** What a screen needs before it can be shown: a signed-in recipient, with or without tips. */
export interface ReviewContext {
  recipient(): Promise<{ handle: string }>;
  recipientWithTips(count: number): Promise<{ handle: string }>;
}

/**
 * One screen in the owner's review gallery (docs/superpowers/plans/2026-11-03-screen-redesign.md).
 * `board` names the file in docs/design/redesign/boards it is built to, without `.dc.html`.
 */
export interface ReviewScreen {
  group: string;
  name: string;
  board: string;
  open(page: Page, ctx: ReviewContext): Promise<void>;
}

const visit = (path: string) => async (page: Page) => {
  await page.goto(path);
};

/**
 * Tips ₦2,000 to the demo page through the pretend provider and lands on the receipt. With a
 * state, the status response is held there for this page only; without, it is the real thing.
 */
function afterTip(held: string | null) {
  return async (page: Page) => {
    if (held)
      await page.route('**/v1/tips/*/status', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({
          response,
          json: { data: { ...body.data, state: held, completedAt: null } },
        });
      });
    await page.goto('/@ada');
    await page.getByRole('radio', { name: '2,000 NGN' }).click();
    await page.getByRole('button', { name: /^Tip ₦/ }).click();
    await page.waitForURL(/\/mock-checkout\/mock_pay_/);
    await page.getByRole('button', { name: /^Pay/ }).click();
    await page.waitForURL(/\/tip\/[0-9a-f-]{36}/);
  };
}

/** Each task of the redesign adds the screens it rebuilds, in the order of the plan. */
export const SCREENS: ReviewScreen[] = [
  { group: 'Public', name: 'Home', board: 'ScreenHome', open: visit('/') },
  {
    group: 'Public',
    name: 'Card turned over',
    board: 'ScreenHome',
    // Zainab is in the centre when the page opens; clicking her turns her over to her postcard.
    // A touch screen gets the plain card (the cards answer a mouse only), so there it stays face up.
    open: async (page) => {
      await page.goto('/');
      const zainab = page.locator('.home-demo__card--zainab');
      await zainab.locator('.home-flip__front').waitFor();
      if (!(await page.evaluate(() => matchMedia('(hover: hover)').matches)))
        return;
      await page.locator('.home-flip[data-ready="true"]').first().waitFor();
      await zainab.click();
      await page.locator('.home-flip[data-flipped="true"]').waitFor();
    },
  },
  {
    group: 'Public',
    name: 'Menu open',
    board: 'PhonePages',
    // On a phone this is the whole menu button; wider, the "Who it's for" choices under their button.
    open: async (page) => {
      await page.goto('/');
      const menu = page.getByRole('button', { name: 'Menu' });
      if (await menu.isVisible()) {
        await menu.click();
        // The menu covers the screen on a phone; a full-page shot would also show the page
        // beneath it, past the screen's edge, so that page is set aside for the picture.
        await page.addStyleTag({
          content:
            'body > main, body > .site-footer { display: none !important; }',
        });
      } else await page.getByRole('button', { name: "Who it's for" }).click();
    },
  },
  {
    group: 'Public',
    name: 'Individuals',
    board: 'PageCreators',
    open: visit('/for-creators'),
  },
  {
    group: 'Public',
    name: 'Businesses',
    board: 'PageBusinesses',
    open: visit('/for-businesses'),
  },
  { group: 'Public', name: 'Pro', board: 'PagePro', open: visit('/pro') },
  {
    group: 'Tipping',
    name: 'Tip page',
    board: 'TipJourney',
    open: visit('/@ada'),
  },
  // The three after-tip screens hold the real status response at one state, for the page only.
  {
    group: 'Tipping',
    name: 'Waiting',
    board: 'TipJourney',
    open: afterTip('waiting'),
  },
  {
    group: 'Tipping',
    name: 'Thank you',
    board: 'ScreenThanks',
    open: afterTip(null),
  },
  {
    group: 'Tipping',
    name: "Didn't go through",
    board: 'TipJourney',
    open: afterTip('declined'),
  },
  // No board shows this page; TipJourney and PagePro show the materials it specimens.
  {
    group: 'Foundations',
    name: 'Design system',
    board: 'TipJourney',
    open: visit('/design-system'),
  },
  // No board shows this notice; TipJourney shows the materials it uses (a raised card, one black
  // action). The server is made to answer with a newer build and the tab to come back.
  {
    group: 'Foundations',
    name: 'Update available',
    board: 'TipJourney',
    async open(page) {
      await page.route('**/api/version', (route) =>
        route.fulfill({
          json: { version: 'a-newer-build' },
          headers: { 'cache-control': 'no-store' },
        }),
      );
      await page.goto('/');
      const notice = page.getByRole('status').filter({
        hasText: 'TipMe has been updated.',
      });
      for (let tries = 0; tries < 20 && !(await notice.isVisible()); tries++) {
        await page.evaluate(() =>
          document.dispatchEvent(new Event('visibilitychange')),
        );
        await page.waitForTimeout(150);
      }
    },
  },
];
