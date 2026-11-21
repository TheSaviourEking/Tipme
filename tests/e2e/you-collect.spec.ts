import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { chooseBank } from './bank-fixtures';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';
import { API_ORIGIN, E2E_REDIS_URL, LANE, stackEnv } from './stack';
import { tipFromProfile } from '../shared/tip-flow';

/*
 * You collect (plan Task 14, spec §2 and §10): what a recipient on `collect` and their supporters
 * see. The `you_collect` switch stays off on this stack, so every sign-up here is undecided
 * (direct); a test puts its own page on `collect` in the lane's database, as a sign-up with the
 * switch on would. Everything after that is the real API on the pretend payment partner.
 */

// The spec's words (§10), as a reader sees them. COLLECT_COPY is checked against the spec in
// apps/web/test/collect-copy.test.mjs; these are what the browser must show.
const COPY = {
  noBank:
    'You can take tips now. Add your bank details when you want to withdraw.',
  kept: 'Kept for you until you add your bank details.',
  addBank: 'Add bank details to withdraw',
  ownName: 'Use a bank account in your own name.',
  checking: "We're checking your details. This usually takes a few minutes.",
  manual: "We're checking this by hand. We'll tell you when it's done.",
  mismatch:
    "This account isn't in your name. Use a bank account in your own name.",
  verified: "You're all set. Your tips are on their way to you.",
  paused:
    'Your page has paused tips. Add your bank details to start taking tips again.',
} as const;

// A route stub still running when a test ends (its page or a visitor's context closing) must not
// fail the test with "Response has been disposed" (re-review 2 R2-M2).
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const VIEWPORTS = [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 900 }],
] as const;

async function database() {
  const { openTestDatabase } =
    await import('../../packages/database/dist/test-support.js');
  return openTestDatabase();
}

/** Puts this handle's page on You collect, as a sign-up with the switch on does. Returns its id. */
async function putOnCollect(handle: string): Promise<string> {
  const db = await database();
  try {
    const { rows } = await db.pool.query<{ id: string }>(
      `UPDATE profiles SET collection_mode = 'collect'
        WHERE handle_lower = $1 RETURNING id`,
      [handle.toLowerCase()],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  } finally {
    await db.close();
  }
}

async function collectionModeOf(handle: string): Promise<string | null> {
  const db = await database();
  try {
    const { rows } = await db.pool.query<{ mode: string | null }>(
      `SELECT collection_mode AS mode FROM profiles WHERE handle_lower = $1`,
      [handle.toLowerCase()],
    );
    return rows[0]?.mode ?? null;
  } finally {
    await db.close();
  }
}

/**
 * The pretend partner's next answer for this recipient's bank (the mock's markCollectAnswer): its
 * account reference is the profile id, as the pretend partner has no accounts.
 */
async function partnerAnswers(
  profileId: string,
  answer: 'destination-rejected' | 'destination-pending-review',
) {
  // ioredis is the payments package's own dependency, as scripts/mock-pay.mjs loads it.
  const { Redis } = createRequire(
    join(__dirname, '../../packages/payments/package.json'),
  )('ioredis') as {
    Redis: new (url: string) => {
      set(key: string, value: string): Promise<unknown>;
      disconnect(): void;
    };
  };
  const redis = new Redis(E2E_REDIS_URL);
  try {
    await redis.set(
      `mockprovider:${LANE.queuePrefix}:collect-answer:${profileId}`,
      answer,
    );
  } finally {
    redis.disconnect();
  }
}

const hintOf = (email: string) => {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

/**
 * The newest bank-account code email to this address, once it has arrived. `notBefore`: codes
 * already used, so a second add waits for its own email.
 */
async function bankCode(page: Page, email: string, notBefore: string[] = []) {
  const inbox = await page.context().newPage();
  try {
    let found = '';
    await expect(async () => {
      await inbox.goto('/dev/inbox');
      await expect(inbox.getByRole('article').first()).toBeVisible();
      const mails = await inbox
        .getByRole('article')
        .filter({ hasText: hintOf(email) })
        .filter({ hasText: 'Confirm your TipMe bank account' })
        .allTextContents();
      found = /\b(\d{6})\b/.exec(mails[0] ?? '')?.[1] ?? '';
      expect(found).not.toBe('');
      expect(notBefore).not.toContain(found);
    }).toPass({ timeout: 20_000 });
    return found;
  } finally {
    await inbox.close();
  }
}

/** A new recipient whose page is live and on You collect, on their Withdraw page. */
async function collectRecipient(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
) {
  const who = await signUpRecipient(page, testInfo);
  const profileId = await putOnCollect(who.handle);
  return { ...who, profileId };
}

/** The add-bank-details form on Withdraw. */
const bankForm = (page: Page) =>
  page.getByRole('region', { name: COPY.addBank });

const BANK = 'Pretend Guaranty Bank';

/** The phone's Bank field is a button that opens a full-screen sheet; a desktop's is a combobox. */
const onPhone = (page: Page) => (page.viewportSize()?.width ?? 0) <= 640;

async function pickBank(page: Page, form: Locator) {
  if (!onPhone(page)) return chooseBank(form, 'guaranty', BANK);
  await form.getByRole('button', { name: /^Bank/ }).click();
  const sheet = form.getByRole('dialog', { name: 'Choose your bank' });
  await sheet
    .getByRole('combobox', { name: 'Search your bank' })
    .fill('guaranty');
  await sheet.getByRole('option', { name: BANK, exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(
    form.getByRole('button', { name: /^Bank/ }),
  ).toHaveAccessibleName(`Bank ${BANK}`);
}

/** Fills the details step and asks for the bank's name. */
async function enterDetails(
  page: Page,
  form: Locator,
  accountNumber = '0123456789',
) {
  await form.getByLabel('First name').fill('Ada');
  await form.getByLabel('Last name').fill('Okafor');
  await pickBank(page, form);
  await form.getByLabel('Account number').fill(accountNumber);
  await form.getByRole('button', { name: 'Continue' }).click();
}

/** From "Is this you?" to the code step, and the code from the inbox entered. */
async function confirmAndEnterCode(page: Page, form: Locator, email: string) {
  await expect(
    form.getByText('Is this you? PRETEND ACCOUNT HOLDER'),
  ).toBeVisible();
  await form.getByRole('button', { name: 'Confirm' }).click();
  const code = form.getByLabel('6-digit code');
  await expect(code).toBeVisible();
  await code.fill(await bankCode(page, email));
}

/** The words as they show (the form also says them in a screen-reader-only live line). */
const shownTo = (form: Locator, words: string) =>
  form.locator(':not(.sr-only)').filter({ hasText: words }).last();

/** Types the bank's name into a Bank search, moves to its option and presses Enter on it. */
async function chooseByKeys(page: Page, search: Locator) {
  await page.keyboard.type('guaranty');
  const option = page.getByRole('option', { name: BANK, exact: true });
  const optionId = (await option.getAttribute('id')) ?? '';
  await expect(async () => {
    if ((await search.getAttribute('aria-activedescendant')) !== optionId)
      await page.keyboard.press('ArrowDown');
    await expect(search).toHaveAttribute('aria-activedescendant', optionId, {
      timeout: 200,
    });
  }).toPass({ timeout: 5_000 });
  await page.keyboard.press('Enter');
}

for (const [label, viewport] of VIEWPORTS) {
  test.describe(`${label}`, () => {
    test.use({ viewport });

    test('a new collect recipient sees "You can take tips now…" and the kept-for-you note after a tip', async ({
      page,
      browser,
    }, testInfo) => {
      const { handle } = await collectRecipient(page, testInfo);

      await page.goto('/dashboard');
      const main = page.getByRole('main');
      await expect(main.getByText(COPY.noBank)).toBeVisible();
      await expect(
        main.getByRole('link', { name: COPY.addBank }),
      ).toHaveAttribute('href', '/dashboard/withdraw');

      await tipAsVisitor(browser, handle);
      await page.goto('/dashboard');
      const balance = main.getByRole('region', { name: 'Your balance' });
      await expect(balance.getByTestId('kept')).toContainText(COPY.kept);
      // The tip's share is in the balance, and none of it is ready to withdraw.
      await expect(balance.getByTestId('balance')).not.toHaveText('₦0');
      await expect(balance.getByTestId('ready')).toHaveCount(0);
      await expect(main.getByText(COPY.noBank)).toBeVisible();

      await page.goto('/dashboard/earnings');
      await expect(page.getByRole('main').getByTestId('kept')).toContainText(
        COPY.kept,
      );
      expect(await fitsViewport(page)).toBe(true);
    });

    test('adding bank details: confirm the name, see checking, then all set', async ({
      page,
    }, testInfo) => {
      const { email } = await collectRecipient(page, testInfo);
      await page.goto('/dashboard/withdraw');
      const form = bankForm(page);
      await expect(form.getByText(COPY.ownName)).toBeVisible();
      // The owner's words (fix round 3): the name fields' hint is just this.
      await expect(
        form.getByText('Your full name.', { exact: true }),
      ).toBeVisible();
      await expect(form).not.toContainText('as your bank has it');

      await enterDetails(page, form);
      await confirmAndEnterCode(page, form, email);

      // Hold the partner's answer, so the in-between state can be seen.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route('**/v1/me/collect/bank', async (route) => {
        await held;
        await route.continue();
      });
      await form.getByRole('button', { name: 'Add bank details' }).click();
      await expect(
        page.getByRole('main').getByText(COPY.checking),
      ).toBeVisible();
      release();

      const main = page.getByRole('main');
      await expect(main.getByText(COPY.verified)).toBeVisible();
      // Withdraw works as today, with the first withdrawal's cap said.
      await expect(
        main.getByText(
          /^New accounts can withdraw up to ₦[\d,]+ the first time\.$/,
        ),
      ).toBeVisible();
      await expect(bankForm(page)).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('0123456789');
      await expect(page.locator('body')).not.toContainText(/bachs/i);
      expect(await fitsViewport(page)).toBe(true);
    });

    test('a name mismatch says so and keeps nothing', async ({
      page,
    }, testInfo) => {
      const { email, profileId } = await collectRecipient(page, testInfo);
      await page.goto('/dashboard/withdraw');
      const form = bankForm(page);
      await enterDetails(page, form);
      await confirmAndEnterCode(page, form, email);
      await partnerAnswers(profileId, 'destination-rejected');
      await form.getByRole('button', { name: 'Add bank details' }).click();

      // The words are at the field, tied to it.
      const number = form.getByLabel('Account number');
      await expect(number).toHaveAttribute('aria-invalid', 'true');
      await expect(number).toHaveAccessibleDescription(
        new RegExp(COPY.mismatch.replace(/[.?]/g, '\\$&')),
      );
      await expect(page.getByRole('main').getByText(COPY.verified)).toHaveCount(
        0,
      );

      // Nothing was saved: no bank, and the form again after a reload.
      const status = await page.request.get(`${API_ORIGIN}/v1/me/collect`);
      expect(status.ok()).toBe(true);
      expect((await status.json()).data.bank).toBeNull();
      await page.reload();
      await expect(bankForm(page).getByLabel('Account number')).toHaveValue('');
    });

    test('manual review shows the by-hand message', async ({
      page,
    }, testInfo) => {
      const { email, profileId } = await collectRecipient(page, testInfo);
      await page.goto('/dashboard/withdraw');
      const form = bankForm(page);
      await enterDetails(page, form);
      await confirmAndEnterCode(page, form, email);
      await partnerAnswers(profileId, 'destination-pending-review');
      await form.getByRole('button', { name: 'Add bank details' }).click();

      const main = page.getByRole('main');
      await expect(main.getByText(COPY.manual)).toBeVisible();
      await page.reload();
      await expect(main.getByText(COPY.manual)).toBeVisible();
      await expect(main.getByText(COPY.verified)).toHaveCount(0);
    });

    test('a paused page tells the supporter only that they can’t take tips right now', async ({
      page,
      browser,
    }, testInfo) => {
      const { handle } = await collectRecipient(page, testInfo);
      const said = `${handle} can't take tips right now. Please try again later.`;

      // The recipient: the dashboard banner (the pause is the API's; held here, as reaching the
      // holding cap takes ₦50,000 or 30 days).
      await page.route('**/v1/me/events**', (route) =>
        route.fulfill({ status: 204 }),
      );
      await page.route('**/v1/me/collect', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({
          response,
          json: {
            data: { ...body.data, paused: true, pausedReason: 'days' },
          },
        });
      });
      await page.goto('/dashboard');
      const banner = page.getByRole('main').getByText(COPY.paused);
      await expect(banner).toBeVisible();
      await expect(page.getByRole('main').getByText(COPY.noBank)).toHaveCount(
        0,
      );

      // The supporter: refused before paying, at the quote, with no reason and no amount.
      const context = await browser.newContext({ viewport });
      const supporter = await context.newPage();
      await supporter.route('**/v1/tip-quotes', (route) =>
        route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'PAGE_PAUSED',
              message:
                'This page can’t take tips right now. Please try again later.',
            },
          },
        }),
      );
      await supporter.goto(`/@${handle}`);
      await supporter.getByRole('radio', { name: '2,000 NGN' }).click();
      await supporter.getByRole('button', { name: /^Tip ₦/ }).click();
      const form = supporter.locator('form').filter({ hasText: said });
      await expect(shownTo(form, said)).toBeVisible();
      await expect(form).not.toContainText(
        /cap|limit|50,000|days|bank|paused/i,
      );
      expect(supporter.url()).not.toMatch(/mock-checkout/);

      // And at the intent, if the page paused after the quote: the same words, nothing charged.
      await supporter.unroute('**/v1/tip-quotes');
      await supporter.route('**/v1/tip-intents', (route) =>
        route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'PAGE_PAUSED',
              message:
                'This page can’t take tips right now. Please try again later.',
            },
          },
        }),
      );
      await supporter.reload();
      await supporter.getByRole('radio', { name: '2,000 NGN' }).click();
      await supporter.getByRole('button', { name: /^Tip ₦/ }).click();
      await expect(shownTo(form, said)).toBeVisible();
      expect(supporter.url()).not.toMatch(/mock-checkout/);
      await context.close();
    });

    test('the receipt says Paid to TipMe for the person on a collect tip, and is unchanged on a direct tip', async ({
      page,
      browser,
    }, testInfo) => {
      const { handle } = await collectRecipient(page, testInfo);
      const context = await browser.newContext({ viewport });
      const supporter = await context.newPage();
      await supporter.goto(`/@${handle}`);
      await tipFromProfile(supporter);
      const receipt = supporter.getByRole('region', { name: 'Your receipt' });
      await expect(receipt).toBeVisible({ timeout: 30_000 });
      await expect(
        receipt.getByText(`Paid to TipMe for ${handle}`),
      ).toBeVisible();

      // A direct page (the switch is off: a sign-up is undecided, so direct): today's receipt.
      const other = await browser.newContext();
      const direct = await signUpRecipient(await other.newPage(), {
        ...testInfo,
        workerIndex: testInfo.workerIndex + 5,
      });
      expect(await collectionModeOf(direct.handle)).toBeNull();
      await supporter.goto(`/@${direct.handle}`);
      await tipFromProfile(supporter);
      await expect(receipt).toBeVisible({ timeout: 30_000 });
      await expect(receipt).not.toContainText('Paid to TipMe');
      await context.close();
      await other.close();
    });

    test('the add-bank-details form works by keyboard alone and passes axe', async ({
      page,
    }, testInfo) => {
      const { email } = await collectRecipient(page, testInfo);
      await page.goto('/dashboard/withdraw');
      const form = bankForm(page);
      await expect(form.getByLabel('First name')).toBeVisible();
      await expectAccessible(page);

      await form.getByLabel('First name').focus();
      await page.keyboard.type('Ada');
      await page.keyboard.press('Tab');
      await expect(form.getByLabel('Last name')).toBeFocused();
      await page.keyboard.type('Okafor');
      await page.keyboard.press('Tab');
      if (onPhone(page)) {
        // The phone's Bank button opens its sheet with the search ready (bank-picker.spec.ts).
        const trigger = form.getByRole('button', { name: /^Bank/ });
        await expect(trigger).toBeFocused();
        await page.keyboard.press('Enter');
        const search = form
          .getByRole('dialog', { name: 'Choose your bank' })
          .getByRole('combobox', { name: 'Search your bank' });
        await expect(search).toBeFocused();
        await chooseByKeys(page, search);
        await expect(trigger).toHaveAccessibleName(`Bank ${BANK}`);
        await expect(trigger).toBeFocused();
        // The sheet's close event (a task after it closes) puts focus on the Bank key again: let it
        // run before the next Tab, or that Tab's focus is taken back.
        await page.evaluate(() => new Promise((done) => setTimeout(done, 50)));
      } else {
        const bank = form.getByRole('combobox', { name: 'Bank' });
        await expect(bank).toBeFocused();
        await chooseByKeys(page, bank);
        await expect(bank).toHaveValue(BANK);
      }
      await page.keyboard.press('Tab');
      const number = form.getByLabel('Account number');
      await expect(number).toBeFocused();
      await page.keyboard.type('0123456789');
      await page.keyboard.press('Enter');

      // Each step's first key takes focus as it appears.
      const confirm = form.getByRole('button', { name: 'Confirm' });
      await expect(confirm).toBeFocused();
      await expectAccessible(page);
      await page.keyboard.press('Enter');
      const code = form.getByLabel('6-digit code');
      await expect(code).toBeFocused();
      await expectAccessible(page);
      await page.keyboard.type(await bankCode(page, email));
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('main').getByText(COPY.verified),
      ).toBeVisible();
      await expectAccessible(page);
    });
  });
}

test('nothing changes for a recipient who is not on You collect', async ({
  page,
  browser,
}, testInfo) => {
  // The switch is off on this stack: a new sign-up is undecided, which is direct.
  const { handle } = await signUpRecipient(page, testInfo);
  expect(await collectionModeOf(handle)).toBeNull();
  await tipAsVisitor(browser, handle);

  await page.goto('/dashboard');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('region', { name: 'Your balance' }),
  ).toBeVisible();
  for (const words of [
    COPY.noBank,
    COPY.kept,
    COPY.paused,
    'On its way to you',
  ])
    await expect(main.getByText(words)).toHaveCount(0);

  await page.goto('/dashboard/withdraw');
  await expect(
    main.getByRole('heading', { name: 'Withdraw', exact: true }),
  ).toBeVisible();
  await expect(main.getByTestId('withdraw-available')).toBeVisible();
  await expect(bankForm(page)).toHaveCount(0);
  await expect(main.getByText(/New accounts can withdraw/)).toHaveCount(0);
  // Today's bank chip, with its Change into Get paid.
  await expect(main.getByRole('link', { name: 'Change' })).toHaveAttribute(
    'href',
    '/dashboard/settings#get-paid',
  );
  // Get paid is today's card: its own form, never the You collect one.
  await page.goto('/dashboard/settings#get-paid');
  const card = page.locator('#get-paid');
  await expect(card.getByRole('heading', { name: 'Get paid' })).toBeVisible();
  await expect(bankForm(page)).toHaveCount(0);
});

/** Answers `GET /v1/me/collect` with the real status, changed by `patch` (read at each request). */
async function stubCollect(page: Page, patch: () => Record<string, unknown>) {
  await page.route('**/v1/me/events**', (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.route('**/v1/me/collect', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { data: { ...body.data, ...patch() } },
    });
  });
}

/**
 * Answers `GET /v1/me/payment-account` as a live payment partner would, with `account()` over the
 * real answer: the real `collecting` (the recipient's mode) stays, so the shell's choice is the API's.
 */
async function livePartner(page: Page, account: () => Record<string, unknown>) {
  await page.route('**/v1/me/payment-account', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { data: { ...body.data, ...account() } },
    });
  });
}

const LIVE_PARTNER = {
  enabled: true,
  environment: 'live',
  payoutsEnabled: false,
  feeCollector: null,
  requirementsDue: [],
  lastSyncedAt: null,
};

test('a collect recipient is never told to set up payments, even with a live payment partner', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  // A direct recipient on a live partner with no account: today's notice, so the stub is real.
  let account: Record<string, unknown> = {
    ...LIVE_PARTNER,
    status: null,
    chargesEnabled: false,
  };
  await livePartner(page, () => account);
  await page.goto('/dashboard');
  const attention = page.getByRole('region', { name: 'Needs your attention' });
  await expect(
    attention.getByText('Set up payments to start receiving tips'),
  ).toBeVisible();

  await putOnCollect(handle);
  for (const next of [
    { status: null, chargesEnabled: false },
    // After a bank: the receive-only account takes no charges of its own.
    { status: 'ACTIVE', chargesEnabled: false },
  ]) {
    account = { ...LIVE_PARTNER, ...next };
    for (const path of ['/dashboard', '/dashboard/withdraw']) {
      await page.goto(path);
      await expect(
        page.getByRole('main').getByRole('heading').first(),
      ).toBeVisible();
      await expect(page.getByText(/^Set up payments/)).toHaveCount(0);
      await expect(page.getByText('Finish setting up payments')).toHaveCount(0);
      await expect(page.getByText(/Supporters can’t tip you/)).toHaveCount(0);
    }
  }
  // The first-day steps say nothing about payments either.
  await page.goto('/dashboard');
  await expect(page.getByRole('main').getByText(COPY.noBank)).toBeVisible();
  await expect(page.getByText('Set up payments and payouts')).toHaveCount(0);
});

test('Get paid in Settings is the You collect form: add a bank, then a verified recipient changes it', async ({
  page,
}, testInfo) => {
  const { email } = await collectRecipient(page, testInfo);
  // Sign-up ends on Settings, read before the page went on collect: a fresh load.
  await page.goto('/dashboard');
  await page.goto('/dashboard/settings#get-paid');
  const card = page.locator('#get-paid');
  const form = card.getByRole('region', { name: COPY.addBank });
  await expect(form.getByLabel('First name')).toBeVisible();
  // Never today's form, whose save the API refuses for a collect recipient.
  await expect(
    card.getByRole('button', { name: 'Email me a code' }),
  ).toHaveCount(0);
  // Nor the payment account card: nothing to set up.
  await expect(page.locator('#payments')).toHaveCount(0);

  await enterDetails(page, form);
  await confirmAndEnterCode(page, form, email);
  const first = await form.getByLabel('6-digit code').inputValue();
  await form.getByRole('button', { name: 'Add bank details' }).click();
  await expect(card.getByText('Pretend Guaranty Bank ••6789')).toBeVisible();

  // Withdraw's Change leads here.
  await page.goto('/dashboard/withdraw');
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Change' }),
  ).toHaveAttribute('href', '/dashboard/settings#get-paid');
  await page.getByRole('main').getByRole('link', { name: 'Change' }).click();
  await page.waitForURL(/\/dashboard\/settings#get-paid$/);

  // A verified recipient changes bank under the same (locked) name.
  await card.getByRole('button', { name: 'Change bank account' }).click();
  const change = card.getByRole('region', { name: 'Change bank account' });
  await enterDetails(page, change, '0123456788');
  await expect(
    change.getByText('Is this you? PRETEND ACCOUNT HOLDER'),
  ).toBeVisible();
  await change.getByRole('button', { name: 'Confirm' }).click();
  await change
    .getByLabel('6-digit code')
    .fill(await bankCode(page, email, [first]));
  await change.getByRole('button', { name: 'Add bank details' }).click();
  await expect(card.getByText('Pretend Guaranty Bank ••6788')).toBeVisible();
  await expect(change).toHaveCount(0);
  await page.reload();
  await expect(card.getByText('Pretend Guaranty Bank ••6788')).toBeVisible();
});

test('a collect status that fails to load is a load error with Try again, never the direct Withdraw screen', async ({
  page,
}, testInfo) => {
  await collectRecipient(page, testInfo);
  const failures: [
    string,
    (route: import('@playwright/test').Route) => Promise<void>,
  ][] = [
    [
      '429',
      (route) =>
        route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED' } },
        }),
    ],
    [
      '5xx',
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: { code: 'DEPENDENCY_UNAVAILABLE' } },
        }),
    ],
    ['timeout', (route) => route.abort('timedout')],
    ['network', (route) => route.abort('internetdisconnected')],
  ];
  const main = page.getByRole('main');
  for (const [kind, fail] of failures) {
    await page.route('**/v1/me/collect', fail);
    await page.goto('/dashboard/withdraw');
    await expect(
      main.getByText('We couldn’t load your balance'),
      kind,
    ).toBeVisible({ timeout: 20_000 });
    await expect(main.getByTestId('withdraw-available'), kind).toHaveCount(0);
    await expect(main.getByLabel('Amount (NGN)'), kind).toHaveCount(0);
    await page.unroute('**/v1/me/collect');
    await main.getByRole('button', { name: 'Try again' }).click();
    await expect(bankForm(page).getByLabel('First name'), kind).toBeVisible();
  }
});

test('fresh server state wins over the last answer: manual review that is then refused', async ({
  page,
}, testInfo) => {
  const { email, profileId } = await collectRecipient(page, testInfo);
  await page.goto('/dashboard/withdraw');
  const form = bankForm(page);
  await enterDetails(page, form);
  await confirmAndEnterCode(page, form, email);
  await partnerAnswers(profileId, 'destination-pending-review');
  // The add answers manual review, and the page's next read (right after it) already has no bank:
  // our payment partner's team refused it, and a refused bank is never kept.
  await stubCollect(page, () => ({ bank: null }));
  await form.getByRole('button', { name: 'Add bank details' }).click();
  const main = page.getByRole('main');
  // The read wins: the form again, saying so at the account number.
  const number = bankForm(page).getByLabel('Account number');
  await expect(number).toHaveAttribute('aria-invalid', 'true');
  await expect(number).toHaveAccessibleDescription(
    new RegExp(COPY.mismatch.replace(/[.?]/g, '\\$&')),
  );
  await expect(main.getByText(COPY.manual)).toHaveCount(0);
});

test('fresh server state wins over the last answer: checking, then Check again shows manual review', async ({
  page,
}, testInfo) => {
  const { email } = await collectRecipient(page, testInfo);
  await page.goto('/dashboard/withdraw');
  const form = bankForm(page);
  await enterDetails(page, form);
  await confirmAndEnterCode(page, form, email);
  // The page may read again by itself at any time (its fallback when live updates are off), and
  // each such read still says checking. Only the read Check again makes (asked while that key is
  // busy) has the newer state, so the test proves it is Check again that reads.
  await page.route('**/v1/me/events**', (route) =>
    route.fulfill({ status: 204 }),
  );
  const checkAgain = page
    .getByRole('main')
    .getByRole('button', { name: 'Check again' });
  await page.route('**/v1/me/collect', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const asked =
      (await checkAgain.getAttribute('aria-busy').catch(() => null)) === 'true';
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        data: {
          ...body.data,
          bank: {
            state: asked ? 'manual_review' : 'checking',
            last4: '6789',
            bankName: 'Pretend Guaranty Bank',
          },
        },
      },
    });
  });
  await page.route('**/v1/me/collect/bank', (route) =>
    route.fulfill({ json: { data: { state: 'checking' } } }),
  );
  await form.getByRole('button', { name: 'Add bank details' }).click();
  const main = page.getByRole('main');
  await expect(main.getByText(COPY.checking)).toBeVisible();
  await checkAgain.click();
  await expect(main.getByText(COPY.manual)).toBeVisible();
  await expect(main.getByText(COPY.checking)).toHaveCount(0);
});

test('the add form: the server’s words for an account it can’t check again, a wrong code, a dropped connection, and one request per tap', async ({
  page,
}, testInfo) => {
  const { email } = await collectRecipient(page, testInfo);
  const posts: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/v1\/me\/(collect|payout-destination)/.test(request.url())
    )
      posts.push(new URL(request.url()).pathname);
  });
  const count = (path: string) => posts.filter((p) => p === path).length;
  await page.goto('/dashboard/withdraw');
  const form = bankForm(page);
  await form.getByLabel('First name').fill('Ada');
  await form.getByLabel('Last name').fill('Okafor');
  await pickBank(page, form);
  await form.getByLabel('Account number').fill('0123456789');

  // A double tap on each key sends one request.
  await form.getByRole('button', { name: 'Continue' }).dblclick();
  await expect(
    form.getByText('Is this you? PRETEND ACCOUNT HOLDER'),
  ).toBeVisible();
  expect(count('/v1/me/collect/bank/lookup')).toBe(1);
  await form.getByRole('button', { name: 'Confirm' }).dblclick();
  const code = form.getByLabel('6-digit code');
  await expect(code).toBeVisible();
  expect(count('/v1/me/payout-destination/code')).toBe(1);

  // A wrong code: the code step stays, the field says so and has focus.
  await code.fill('000000');
  await form.getByRole('button', { name: 'Add bank details' }).click();
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(code).toHaveAccessibleDescription(/That code isn’t right/);
  await expect(code).toBeFocused();

  // The server's own words when it can't check this account again.
  const recheck =
    "We can't check this account again right now. Use another account, or contact support@usetipme.xyz.";
  await page.route('**/v1/me/collect/bank', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'BANK_RECHECK_LATER', message: recheck } },
    }),
  );
  const used = [await bankCode(page, email)];
  await code.fill(used[0]!);
  await form.getByRole('button', { name: 'Add bank details' }).click();
  const slip = form.getByRole('alert').filter({ hasText: 'Not added' });
  await expect(slip).toHaveText(new RegExp(recheck.replace(/[.?]/g, '\\$&')));
  await page.unroute('**/v1/me/collect/bank');

  // A dropped connection on the add: the form stays usable and the page reads where it stands.
  let reads = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      new URL(request.url()).pathname === '/v1/me/collect'
    )
      reads += 1;
  });
  await form.getByRole('button', { name: 'Continue' }).click();
  await form.getByRole('button', { name: 'Confirm' }).click();
  await expect(code).toBeVisible();
  used.push(await bankCode(page, email, used));
  await code.fill(used[1]!);
  await page.route('**/v1/me/collect/bank', (route) =>
    route.abort('internetdisconnected'),
  );
  await form.getByRole('button', { name: 'Add bank details' }).click();
  await expect(
    form.getByRole('alert').filter({ hasText: 'Not added' }),
  ).toBeVisible();
  await expect(form.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await page.unroute('**/v1/me/collect/bank');

  // And the real add, double tapped: one request, all set.
  await form.getByRole('button', { name: 'Continue' }).click();
  await form.getByRole('button', { name: 'Confirm' }).click();
  await expect(code).toBeVisible();
  await code.fill(await bankCode(page, email, used));
  const before = count('/v1/me/collect/bank');
  await form.getByRole('button', { name: 'Add bank details' }).dblclick();
  await expect(page.getByRole('main').getByText(COPY.verified)).toBeVisible();
  expect(count('/v1/me/collect/bank') - before).toBe(1);
});

test('a payment being questioned: Home says how much is held while it is, and nothing once settled', async ({
  page,
  browser,
}, testInfo) => {
  // Task 9 holds a share that has already moved into the balance: a verified recipient whose
  // tip's share our payment partner has paid. Long-standing, so no new-recipient delay (§8).
  const { email, handle, profileId } = await collectRecipient(page, testInfo);
  const db = await database();
  let disputeId = '';
  try {
    await db.pool.query(
      `UPDATE profiles SET created_at = now() - interval '60 days' WHERE id = $1`,
      [profileId],
    );
    await page.goto('/dashboard/withdraw');
    const form = bankForm(page);
    // An account number of its own: one another recipient already used would hold this recipient's
    // transfers for review (a shared bank account, Task 13).
    const own = `5${String(Date.now()).slice(-8)}${testInfo.workerIndex % 10}`;
    await enterDetails(
      page,
      form,
      own.endsWith('0000') ? `${own.slice(0, 9)}1` : own,
    );
    await confirmAndEnterCode(page, form, email);
    await form.getByRole('button', { name: 'Add bank details' }).click();
    await expect(page.getByRole('main').getByText(COPY.verified)).toBeVisible();
    await tipAsVisitor(browser, handle);

    // The worker's sweep, run now rather than on its 2-minute timer: release, send, paid.
    const share = async () =>
      (
        await db.pool.query<{ tip: string; amount: string; status: string }>(
          `SELECT t.tip_id AS tip, t.amount_minor::text AS amount, t.status
             FROM collect_transfers t JOIN tips p ON p.id = t.tip_id
            WHERE p.profile_id = $1 AND t.kind = 'share'`,
          [profileId],
        )
      ).rows[0];
    await expect
      .poll(async () => (await share())?.status ?? 'none', { timeout: 20_000 })
      .not.toBe('none');
    await sweepTransfers(db);
    await expect
      .poll(
        async () => {
          if ((await share())?.status !== 'paid') await sweepTransfers(db);
          return (await share())?.status;
        },
        { timeout: 30_000 },
      )
      .toBe('paid');
    const moved = (await share())!;
    // The partner opens a dispute; Task 9 holds the moved share from the balance.
    disputeId = crypto.randomUUID();
    await db.pool.query(
      `INSERT INTO disputes (id, provider, partner_dispute_id, tip_id, amount_minor, currency,
         status, held_minor, share_step, last_event_at)
       SELECT $1, 'mock', $2, p.id, p.gross_minor, 'NGN', 'open', $3, 'balance', now()
         FROM tips p WHERE p.id = $4`,
      [disputeId, `dp_${disputeId.slice(0, 8)}`, moved.amount, moved.tip],
    );
    await page.goto('/dashboard');
    const main = page.getByRole('main');
    const amount = new Intl.NumberFormat('en').format(
      Number(moved.amount) / 100,
    );
    await expect(
      main.getByText(
        `A payment to you is being questioned. We've held ₦${amount} until it's settled.`,
      ),
    ).toBeVisible();
    // A real state: nothing kept or on its way, and the balance is not below zero.
    await expect(main.getByTestId('kept')).toHaveCount(0);
    await expect(main.getByTestId('on-its-way')).toHaveCount(0);
    await expect(main.getByTestId('balance')).toHaveText('₦0');

    await db.pool.query(
      `UPDATE disputes SET status = 'won', held_minor = 0, settled_at = now(), decided_at = now()
        WHERE id = $1`,
      [disputeId],
    );
    await page.reload();
    await expect(main.getByTestId('balance')).toHaveText(`₦${amount}`);
    await expect(page.getByText(/is being questioned/)).toHaveCount(0);
  } finally {
    await db.close();
  }
});

/** One run of the worker's collect-transfers sweep against the pretend partner. */
async function sweepTransfers(db: { db: unknown }) {
  // The worker's build has no type declarations: its two exports, typed here.
  const workerModule = '../../apps/worker/dist/handlers/collect-transfers.js';
  const { handleCollectTransfers, collectTransferProviders } = (await import(
    workerModule
  )) as {
    handleCollectTransfers: (deps: {
      db: never;
      providers: unknown;
      log: (entry: unknown) => void;
    }) => Promise<unknown>;
    collectTransferProviders: (providers: never[]) => unknown;
  };
  const { createMockProvider } =
    await import('../../packages/payments/dist/index.js');
  const { Redis } = createRequire(
    join(__dirname, '../../packages/payments/package.json'),
  )('ioredis') as { Redis: new (url: string) => { disconnect(): void } };
  const redis = new Redis(E2E_REDIS_URL);
  try {
    const provider = createMockProvider({
      redis: redis as never,
      secret: stackEnv.MOCK_PROVIDER_WEBHOOK_SECRET,
      prefix: LANE.queuePrefix,
    });
    await handleCollectTransfers({
      db: db.db as never,
      providers: collectTransferProviders([provider as never]),
      log: (entry: unknown) => console.log('sweep', JSON.stringify(entry)),
    });
  } finally {
    redis.disconnect();
  }
}

test('an undecided recipient who goes on You collect stops seeing set-up notices at the next page, with no reload', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  expect(await collectionModeOf(handle)).toBeNull();
  await livePartner(page, () => ({
    ...LIVE_PARTNER,
    status: null,
    chargesEnabled: false,
  }));
  await page.goto('/dashboard');
  const notice = page
    .getByRole('region', { name: 'Needs your attention' })
    .getByText('Set up payments to start receiving tips');
  await expect(notice).toBeVisible();
  // Their first quote with the switch on decides `collect` (decideCollectionMode); here, the lane's
  // database stands in for it. Then a click in the app, never a reload.
  await putOnCollect(handle);
  const marker = await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
    return true;
  });
  expect(marker).toBe(true);
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Tips', exact: true })
    .first()
    .click();
  await page.waitForURL(/\/dashboard\/tips$/);
  await expect(notice).toHaveCount(0);
  // Visible only: the app keeps the page it left (Home, with its own steps) hidden for going back.
  await expect(
    page.getByText(/^Set up payments/).filter({ visible: true }),
  ).toHaveCount(0);
  // The same document: nothing reloaded it.
  expect(
    await page.evaluate(
      () => (window as unknown as { stayed?: boolean }).stayed === true,
    ),
  ).toBe(true);
});

test('a status read answered while the add is on its way never says the account isn’t in their name', async ({
  page,
  browser,
}, testInfo) => {
  const { email, handle } = await collectRecipient(page, testInfo);
  await page.goto('/dashboard/withdraw');
  const form = bankForm(page);
  await enterDetails(page, form);
  await confirmAndEnterCode(page, form, email);

  // Watch for the mismatch words or an invalid field at any moment, not only at the end.
  await page.evaluate((words) => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    new MutationObserver(() => {
      const main = document.querySelector('main');
      if (main?.textContent?.includes(words)) seen.push('words');
      if (main?.querySelector('[aria-invalid="true"]')) seen.push('invalid');
      if (main?.querySelector('[role="alert"]')) seen.push('alert');
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }, COPY.mismatch);

  // The add is held. Meanwhile a tip arrives (tips.changed), and the page reads the status again:
  // still no bank, as the add has not answered yet.
  let answered = false;
  let readsDuringAdd = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/v1/me/collect', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (!answered) readsDuringAdd += 1;
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        data: {
          ...body.data,
          bank: answered
            ? { state: 'checking', last4: '6789', bankName: BANK }
            : null,
        },
      },
    });
  });
  await page.route('**/v1/me/collect/bank', async (route) => {
    await held;
    answered = true;
    await route.fulfill({ json: { data: { state: 'checking' } } });
  });
  await form.getByRole('button', { name: 'Add bank details' }).click();
  const main = page.getByRole('main');
  await expect(main.getByText(COPY.checking)).toBeVisible();
  const before = readsDuringAdd;
  await tipAsVisitor(browser, handle);
  await expect
    .poll(() => readsDuringAdd, { timeout: 20_000 })
    .toBeGreaterThan(before);
  release();

  await expect(main.getByText(COPY.checking)).toBeVisible();
  await expect(main.getByRole('button', { name: 'Check again' })).toBeVisible();
  // Give any late render a moment to show itself, then check nothing ever did.
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as unknown as { seen: string[] }).seen),
  ).toEqual([]);
  await expect(main.getByText(COPY.mismatch)).toHaveCount(0);
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute('inputmode') ?? '',
  );
  expect(focused).not.toBe('numeric');
});

test('with the switch on, an undecided recipient whose first tip would go to TipMe is shown You collect at once, and nothing is written @alone', async ({
  page,
}, testInfo) => {
  // Two switch changes, each up to 15 s to reach the API's cache.
  test.setTimeout(150_000);
  // Signed up with the switch off: undecided, no payment account.
  const { handle } = await signUpRecipient(page, testInfo);
  expect(await collectionModeOf(handle)).toBeNull();
  await livePartner(page, () => ({
    ...LIVE_PARTNER,
    status: null,
    chargesEnabled: false,
  }));
  const main = page.getByRole('main');
  const notice = page
    .getByRole('region', { name: 'Needs your attention' })
    .getByText('Set up payments to start receiving tips');
  await page.goto('/dashboard');
  await expect(notice).toBeVisible();
  await expect(main.getByText(COPY.noBank)).toHaveCount(0);

  const db = await database();
  try {
    // Staff turn the switch on (written directly). The API reads switches within 15 seconds.
    await db.pool.query(
      `INSERT INTO feature_switches (key, enabled, source, changed_at, reason)
       VALUES ('you_collect', true, 'staff', now(), 'e2e: the mode preview')
       ON CONFLICT (key) DO UPDATE SET enabled = true, source = 'staff'`,
    );
    // Their next quote would put them on You collect (no account of their own), so the screens say
    // so now: no set-up notice, and "You can take tips now".
    await expect(async () => {
      await page.goto('/dashboard');
      await expect(main.getByText(COPY.noBank)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 40_000, intervals: [2000] });
    await expect(notice).toHaveCount(0);
    // Read-only: still undecided. The first quote (or adding bank details) fixes it.
    expect(await collectionModeOf(handle)).toBeNull();
  } finally {
    // Back to the lane's seed: off.
    await db.pool.query(
      `DELETE FROM feature_switches WHERE key = 'you_collect'`,
    );
    await db.close();
  }
  // Off again: undecided reads as direct, as before.
  await expect(async () => {
    await page.goto('/dashboard');
    await expect(notice).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 40_000, intervals: [2000] });
  await expect(main.getByText(COPY.noBank)).toHaveCount(0);
  expect(await collectionModeOf(handle)).toBeNull();
});
