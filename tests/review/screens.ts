import type { Page } from '@playwright/test';
import { API_ORIGIN } from '../e2e/stack';

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
  /** Its phone shot is one screen tall, not the whole page, so fixed bars sit where they do on a phone. */
  viewport?: boolean;
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

/** Asks for a sign-in code for a new address and waits for the code step. */
async function atCodeStep(page: Page, path: string) {
  await page.goto(path);
  await page.getByLabel('Email address').fill('ada@example.com');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').waitFor();
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
    viewport: true,
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
  {
    group: 'Accounts',
    name: 'Sign up',
    board: 'ScreenAccess',
    open: visit('/sign-up'),
  },
  {
    group: 'Accounts',
    name: 'Sign in',
    board: 'ScreenAccess',
    open: visit('/sign-in'),
  },
  {
    group: 'Accounts',
    name: 'Sign in code',
    board: 'ScreenAccess',
    async open(page) {
      await atCodeStep(page, '/sign-in');
      await page.getByLabel('6-digit code').pressSequentially('4829');
    },
  },
  {
    group: 'Accounts',
    name: 'Recovery',
    board: 'ScreenAccess',
    open: visit('/recover'),
  },
  {
    group: 'Accounts',
    name: 'Recovery sent',
    board: 'ScreenAccess',
    async open(page) {
      await page.goto('/recover');
      await page.getByLabel('Your sign-in email').fill('ada@example.com');
      await page.getByRole('button', { name: 'Send recovery code' }).click();
      await page.getByRole('status').waitFor();
    },
  },
  {
    group: 'Accounts',
    name: 'Welcome step 2',
    board: 'ScreenWelcome',
    async open(page, ctx) {
      await ctx.recipient();
      await page.goto('/dashboard/welcome');
      await page
        .getByRole('button', { name: 'Let’s set up your page' })
        .click();
      await page.getByLabel('Your name').fill('Ada Okafor');
      await page.getByLabel('What you do').fill('Maths tutor');
    },
  },
  // The server's answer is held at "confirmed" for the page only; no real link is needed.
  {
    group: 'Accounts',
    name: 'Email verified',
    board: 'ScreenAccess',
    async open(page) {
      await page.route('**/v1/auth/email/confirm', (route) =>
        route.fulfill({ json: { data: { confirmed: true } } }),
      );
      await page.goto('/verify-email#v=review');
      await page
        .getByRole('heading', { name: 'Your email is verified.' })
        .waitFor();
    },
  },
  {
    group: 'Accounts',
    name: 'Unsubscribed',
    board: 'ScreenAccess',
    async open(page) {
      await page.route('**/v1/mail/unsubscribe*', (route) =>
        route.fulfill({ json: { data: { type: 'weekly_report' } } }),
      );
      await page.goto('/email/unsubscribed?t=review');
      await page.getByRole('button', { name: 'Turn off this email' }).click();
      await page
        .getByRole('heading', { name: 'You’re unsubscribed.' })
        .waitFor();
    },
  },
  {
    group: 'Dashboard',
    name: 'Dashboard with tips',
    board: 'ScreenDashboard',
    viewport: true,
    async open(page, ctx) {
      await ctx.recipientWithTips(3);
      await page.goto('/dashboard');
      await page.getByRole('heading', { name: 'Your balance' }).waitFor();
    },
  },
  {
    group: 'Dashboard',
    name: 'Before the first tip',
    board: 'ScreenFirstDay',
    viewport: true,
    async open(page, ctx) {
      await ctx.recipient();
      await page.goto('/dashboard');
      await page
        .getByRole('heading', { name: 'Get your page ready to share' })
        .waitFor();
    },
  },
  {
    group: 'Dashboard',
    name: 'Tips',
    board: 'ScreenTips',
    async open(page, ctx) {
      await ctx.recipientWithTips(3);
      await page.goto('/dashboard/tips');
      await page
        .getByRole('link', { name: /Tip from/ })
        .first()
        .waitFor();
    },
  },
  {
    group: 'Dashboard',
    name: 'Tip detail',
    board: 'ScreenTipReport',
    async open(page, ctx) {
      await ctx.recipientWithTips(1);
      await page.goto('/dashboard/tips');
      await page
        .getByRole('link', { name: /Tip from/ })
        .first()
        .click();
      await page.locator('.receipt').waitFor();
    },
  },
  {
    group: 'Dashboard',
    name: 'Weekly report',
    board: 'ScreenTipReport',
    async open(page, ctx) {
      const { handle } = await ctx.recipientWithTips(2);
      // The week's report is written by the worker on a Monday; the dev route does it now.
      const isoWeek = await page.evaluate(() => {
        const now = new Date(Date.now() + 3600_000);
        const day = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
        const week = Math.ceil(
          ((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / 86400000 +
            1) /
            7,
        );
        return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
      });
      await page.request.post(`${API_ORIGIN}/v1/dev/jobs/weekly-report`, {
        data: { handle, isoWeek },
      });
      await page.goto(`/dashboard/reports/${isoWeek}`);
      await page.getByRole('heading', { level: 1 }).waitFor();
    },
  },
  {
    group: 'Dashboard',
    name: 'Withdraw',
    board: 'ScreenWithdraw',
    async open(page, ctx) {
      await ctx.recipientWithTips(3);
      await page.goto('/dashboard/withdraw');
      await page.getByRole('button', { name: 'Everything' }).click();
    },
  },
  {
    group: 'Dashboard',
    name: 'Withdraw, one on its way',
    board: 'ScreenWithdraw',
    async open(page, ctx) {
      await ctx.recipientWithTips(3);
      // Only the withdrawal list is stubbed; the balance and the quote are the real ones.
      await page.route('**/v1/me/withdrawals*', (route) =>
        route.request().method() !== 'GET'
          ? route.continue()
          : route.fulfill({
              json: {
                data: {
                  nextCursor: null,
                  items: [
                    [
                      'w1',
                      new Date().toISOString(),
                      null,
                      '2000000',
                      'processing',
                      null,
                    ],
                    [
                      'w2',
                      '2026-10-24T08:00:00.000000Z',
                      '2026-10-24T09:00:00.000000Z',
                      '3500000',
                      'sent',
                      { bankName: 'GTBank', last4: '6789' },
                    ],
                    [
                      'w3',
                      '2026-10-17T09:00:00.000000Z',
                      null,
                      '1250000',
                      'failed',
                      null,
                    ],
                  ].map(
                    ([
                      payoutId,
                      requestedAt,
                      paidAt,
                      amountMinor,
                      state,
                      bank,
                    ]) => ({
                      payoutId,
                      requestedAt,
                      paidAt,
                      currency: 'NGN',
                      amountMinor,
                      state,
                      bank,
                    }),
                  ),
                },
              },
            }),
      );
      await page.goto('/dashboard/withdraw');
      await page.getByRole('list', { name: 'Progress' }).waitFor();
    },
  },
  // Settings (ScreenSettings): one shot per section, reached by its link. Shots are full-page, so
  // each shows the whole of Settings; the section's link is the current one.
  ...(
    [
      ['My page', 'page'],
      ['Getting paid', 'paid'],
      ['Notifications', 'notifications'],
      ['Sign-in and security', 'security'],
      ['Plan', 'plan'],
      ['Your data and page', 'data'],
    ] as const
  ).map(([name, id]): ReviewScreen => ({
    group: 'Dashboard',
    name: `Settings, ${name}`,
    board: 'ScreenSettings',
    async open(page, ctx) {
      await ctx.recipient();
      await page.goto('/dashboard/settings');
      // My page shows the preview following an edit that is not saved yet.
      if (id === 'page')
        await page.getByLabel('What you do').fill('Maths tutor');
      await page
        .locator('nav[aria-label="Settings"]')
        .getByRole('link', { name, exact: true })
        .click();
      await page
        .locator(`section#${id}`)
        .getByRole('heading', { level: 2, name, exact: true })
        .waitFor();
    },
  })),
  {
    group: 'Small screens',
    name: 'Page not found',
    board: 'ScreenSmall',
    open: visit('/@tobi_s/tips'),
  },
  {
    group: 'Small screens',
    name: 'Page unavailable',
    board: 'ScreenSmall',
    open: visit('/@tobi_s'),
  },
  {
    group: 'Small screens',
    name: 'Something went wrong',
    board: 'ScreenSmall',
    open: visit('/dev/crash'),
  },
  {
    group: 'Small screens',
    name: 'Tipping opens soon',
    board: 'ScreenSmall',
    // The API answers that tipping is closed once the supporter presses Tip; the card takes the form's place.
    async open(page) {
      await page.goto('/@ada');
      const origin = new URL(page.url()).origin;
      const cors = { 'access-control-allow-origin': origin };
      await page.route('**/v1/tip-quotes', (route) =>
        route.request().method() === 'OPTIONS'
          ? route.fulfill({
              status: 204,
              headers: { ...cors, 'access-control-allow-headers': '*' },
            })
          : route.fulfill({
              status: 403,
              headers: cors,
              contentType: 'application/json',
              body: JSON.stringify({ error: { code: 'TIPPING_NOT_OPEN' } }),
            }),
      );
      await page.getByRole('radio', { name: '2,000 NGN' }).click();
      await page.getByRole('button', { name: /^Tip ₦/ }).click();
      await page
        .getByRole('heading', { name: /^Tipping opens soon/ })
        .waitFor();
    },
  },
  {
    group: 'Small screens',
    name: 'Privacy',
    board: 'ScreenSmall',
    open: visit('/legal/privacy'),
  },
  {
    group: 'Small screens',
    name: 'Terms',
    board: 'ScreenSmall',
    open: visit('/legal/terms'),
  },
];
