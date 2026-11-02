import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  CELEBRATION,
  startStack,
  type Mode,
  type Stack,
} from './profile-fixtures';

// The owner-approved compact tip card (2 Nov 2026), on the built web app against the stand-in API.
// Calls the browser makes for prices and tips are answered here: nothing reaches any provider.

const TRUST = 'No account needed. You’ll see the full total before you pay.';
const DISCLOSURE = 'Add a message, reason or your name';
const WIDTHS = [320, 360, 390, 768, 1280];
const OTHER = /^Other amount/;
const PARTNER = {
  live: 'Our payment partner handles this. You’ll confirm on its page.',
  test: 'A test page stands in for our payment partner. Confirm there.',
};

const tipButton = (page: Page) => page.getByRole('button', { name: /^Tip\b/ });
const card = (page: Page) =>
  page.locator('[data-tip-panel] .appreciation-card');
const summary = (page: Page) => page.getByText(DISCLOSURE);

const stacks = new Map<string, Stack>();
const at = async (
  mode: Mode,
  path: string,
  page: Page,
  options: { pilotNotice?: boolean } = {},
) => {
  const key = `${mode}${options.pilotNotice ? '+pilot' : ''}`;
  let stack = stacks.get(key);
  if (!stack) {
    stack = await startStack(mode, options);
    stacks.set(key, stack);
  }
  await page.goto(`${stack.origin}${path}`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  return stack.origin;
};

// In file order on one worker, so the stacks are shared; a failure doesn't skip the rest.
test.describe.configure({ mode: 'default' });
test.setTimeout(120_000);
test.afterAll(async () => {
  await Promise.all([...stacks.values()].map((s) => s.stop()));
  stacks.clear();
});

/** Answers the browser's API calls and records what the form sent. */
async function answerApi(page: Page, origin: string) {
  const sent = {
    quotes: 0,
    intents: [] as Record<string, unknown>[],
    events: [] as string[],
  };
  const cors = {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  };
  const preflight = (method: string) => method === 'OPTIONS';
  await page.route('**/v1/tip-quotes', async (route) => {
    if (preflight(route.request().method()))
      return route.fulfill({ status: 204, headers: cors });
    sent.quotes += 1;
    const body = route.request().postDataJSON() as { amountMinor: string };
    return route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          quoteId: '22222222-2222-4222-8222-222222222222',
          handle: 'x',
          displayName: 'x',
          currency: 'NGN',
          tipMinor: body.amountMinor,
          platformFeeMinor: '0',
          providerFeeMinor: '0',
          recipientNetMinor: body.amountMinor,
          payerTotalMinor: body.amountMinor,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          feePolicyVersion: 'test',
          feeFree: false,
        },
      }),
    });
  });
  await page.route('**/v1/tip-intents', async (route) => {
    if (preflight(route.request().method()))
      return route.fulfill({ status: 204, headers: cors });
    sent.intents.push(
      route.request().postDataJSON() as Record<string, unknown>,
    );
    return route.fulfill({
      status: 201,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          tipId: '33333333-3333-4333-8333-333333333333',
          statusToken: 'token',
          checkoutUrl: `${origin}/legal/terms`,
        },
      }),
    });
  });
  await page.route('**/v1/{events,vitals}', async (route) => {
    if (!preflight(route.request().method()))
      sent.events.push(route.request().postData() ?? '');
    return route.fulfill({ status: 202, headers: cors, body: '{}' });
  });
  return sent;
}

const mode: Mode[] = ['test', 'live'];

for (const m of mode)
  test(`closed card height at 1280 in ${m} mode, with four and six amounts, and no inner scrolling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    for (const [path, ceiling] of [
      // Linux fonts run a little wider than a Mac's and can wrap a line.
      ['/@dr7', 520],
      ['/@sixkeys', 580],
    ] as const) {
      await at(m, path, page, { pilotNotice: m === 'live' });
      // The pilot notice streams in after the form; measure the card as the supporter gets it.
      if (m === 'live') await page.getByTestId('pilot-notice').waitFor();
      await tipButton(page).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const height = (await card(page).boundingBox())!.height;
      console.log(`card height ${m} ${path}: ${Math.round(height)}px`);
      test.info().annotations.push({
        type: 'height',
        description: `${m} ${path} ${Math.round(height)}`,
      });
      expect(height).toBeLessThanOrEqual(ceiling);
      const inner = await card(page).evaluate((el) => {
        const all = [el, ...el.querySelectorAll('*')];
        return all
          .filter((node) => {
            const style = getComputedStyle(node);
            return (
              /auto|scroll/.test(style.overflowY) &&
              node.tagName !== 'TEXTAREA' &&
              node.scrollHeight > node.clientHeight
            );
          })
          .map((node) => node.className);
      });
      expect(inner).toEqual([]);
    }
  });

test('keys hold exact full amounts in clean rows at every width, with no lone key', async ({
  page,
}) => {
  for (const [path, labels] of [
    ['/@dr7', ['₦10,000', '₦20,000', '₦50,000', '₦100,000']],
    ['/@fivekeys', ['₦1,000', '₦3,000', '₦5,000', '₦10,000', '₦100,000']],
    [
      '/@sixkeys',
      ['₦1,000', '₦2,000', '₦5,000', '₦10,000', '₦50,000', '₦100,000'],
    ],
    [
      '/@eightkeys',
      [
        '₦1,000',
        '₦1,500',
        '₦3,000',
        '₦5,000',
        '₦10,000',
        '₦20,000',
        '₦50,000',
        '₦100,000',
      ],
    ],
  ] as const) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await at('live', path, page);
      const keys = page.locator('.amount-options .tm-amount-choice');
      await expect(keys).toHaveText([...labels]);
      // Selecting a key must not clip it: measure each key while it is the selected one.
      for (let index = 0; index < labels.length; index += 1) {
        await keys.nth(index).click();
        const clipped = await keys.evaluateAll((all) =>
          all.flatMap((label) => {
            const span = label.querySelector('span')!;
            const range = document.createRange();
            range.selectNodeContents(span);
            const text = range.getBoundingClientRect();
            const box = span.getBoundingClientRect();
            return text.left < box.left ||
              text.right > box.right ||
              text.height > 24
              ? [label.textContent]
              : [];
          }),
        );
        expect(clipped, `${path} at ${width}`).toEqual([]);
      }
      const rows = new Map<number, number>();
      for (const box of await keys.evaluateAll((all) =>
        all.map((label) => Math.round(label.getBoundingClientRect().top)),
      ))
        rows.set(box, (rows.get(box) ?? 0) + 1);
      expect([...rows.values()].at(-1), `${path} at ${width}`).toBeGreaterThan(
        1,
      );
      // Other is a full-width field below the keys, not a key.
      await expect(
        page.getByRole('radio', { name: 'Other amount' }),
      ).toHaveCount(0);
      const field = (await page.getByLabel(OTHER).boundingBox())!;
      const group = (await page.locator('.amount-options').boundingBox())!;
      expect(field.y).toBeGreaterThanOrEqual(group.y + group.height);
      expect(Math.abs(field.width - group.width)).toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
});

test('a typed amount: minimum rule, wording, focus, and the Tip label follow it @mobile', async ({
  page,
}) => {
  const origin = await at('live', '/@dr7', page);
  await answerApi(page, origin);
  const field = page.getByLabel(OTHER);
  await field.fill('500');
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
  await field.blur(); // The bar steps aside while the field has focus.
  await tipButton(page).click();
  await expect(
    page.getByText(
      /^Enter an amount of NGN 10,000 or more, like 10,000 or 2,500\.50\.$/,
    ),
  ).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await field.fill('12500');
  await expect(page.getByText(/Enter an amount/)).toHaveCount(0);
  await field.blur();
  await expect(tipButton(page)).toHaveText(/^Tip ₦12,500/);
  // Choosing a key replaces the typed amount: only one amount is ever on show.
  await page.getByRole('radio', { name: '20,000 NGN' }).click();
  await expect(field).toHaveValue('');
  await expect(tipButton(page)).toHaveText(/^Tip ₦20,000/);
});

test('the disclosure is closed by default, opens in 240ms on opacity and transform only, and moves nothing above it', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await at('live', '/@dr7', page);
  const details = page.locator('.composer-extras');
  await expect(details).not.toHaveAttribute('open');
  await expect(page.getByLabel('Personal message (optional)')).toBeHidden();
  await expect(page.getByText('Add your name or remember tips')).toHaveCount(0);
  // The panel's own 240ms arrival has finished.
  await page.waitForTimeout(350);
  const before = (await summary(page).boundingBox())!;
  const keysBefore = (await page.locator('.amount-options').boundingBox())!;
  await summary(page).click();
  await expect(details).toHaveAttribute('open');
  const body = page.locator('.composer-extras__body');
  await expect(body).toHaveCSS('animation-duration', '0.24s');
  const properties = await body.evaluate((el) =>
    el
      .getAnimations()
      .flatMap((a) =>
        (a.effect as KeyframeEffect)
          .getKeyframes()
          .flatMap((frame) =>
            Object.keys(frame).filter(
              (k) =>
                !['offset', 'computedOffset', 'easing', 'composite'].includes(
                  k,
                ),
            ),
          ),
      ),
  );
  for (const property of properties)
    expect(['opacity', 'transform', 'translate']).toContain(property);
  expect(
    Math.abs((await summary(page).boundingBox())!.y - before.y),
  ).toBeLessThanOrEqual(1);
  expect((await page.locator('.amount-options').boundingBox())!.y).toBe(
    keysBefore.y,
  );
});

test('with reduced motion the disclosure opens at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await at('live', '/@dr7', page);
  await summary(page).click();
  await expect(page.locator('.composer-extras__body')).toHaveCSS(
    'animation-name',
    'none',
  );
});

test('keyboard: Tab order and Enter on the disclosure, Space on the tick box; drafts survive closing and opening', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await at('live', '/@dr7', page);
  const checked = page.getByRole('radio', { name: '10,000 NGN' });
  await checked.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(OTHER)).toBeFocused();
  await page.keyboard.press('Tab');
  const tick = page.getByRole('checkbox', { name: 'Add to the celebration' });
  await expect(tick).toBeFocused();
  await page.keyboard.press('Space');
  await expect(tick).toBeChecked();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('.composer-extras')).toHaveAttribute('open');
  await page.keyboard.press('Tab');
  await expect(
    page.getByLabel('What is this tip for? (optional)'),
  ).toBeFocused();
  await page
    .getByLabel('What is this tip for? (optional)')
    .selectOption({ index: 1 });
  await page.getByLabel('Personal message (optional)').fill('Thank you.');
  await page.getByLabel('Your name (optional)').fill('Ngozi');
  await page.getByLabel('Remember my tips on this phone').check();
  await summary(page).click();
  await expect(page.locator('.composer-extras')).not.toHaveAttribute('open');
  await summary(page).click();
  await expect(page.getByLabel('Personal message (optional)')).toHaveValue(
    'Thank you.',
  );
  await expect(page.getByLabel('Your name (optional)')).toHaveValue('Ngozi');
  await expect(page.getByLabel('Remember my tips on this phone')).toBeChecked();
  await expect(
    page.getByLabel('What is this tip for? (optional)'),
  ).not.toHaveValue('');
  await expect(tick).toBeChecked();
});

test('an error inside the disclosure opens it and takes focus', async ({
  page,
}) => {
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  await summary(page).click();
  // The field stops at 280; a pasted-in value from a script or extension is the only way past it.
  const message = page.getByLabel('Personal message (optional)');
  await message.evaluate((el) => el.removeAttribute('maxlength'));
  await message.fill('x'.repeat(281));
  await summary(page).click();
  await expect(page.locator('.composer-extras')).not.toHaveAttribute('open');
  await page.getByRole('radio', { name: '20,000 NGN' }).click();
  await expect(page.getByText(/You pay/)).toBeVisible();
  await tipButton(page).click();
  await expect(page.locator('.composer-extras')).toHaveAttribute('open');
  await expect(
    page.getByText('Keep your message to 280 characters.'),
  ).toBeVisible();
  await expect(message).toBeFocused();
  expect(sent.intents).toEqual([]);
});

for (const m of ['test', 'live'] as const)
  test(`one trust line and the mode wording once, in ${m} mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await at(m, '/@dr7', page, { pilotNotice: true });
    const panel = page.locator('[data-tip-panel]');
    await expect(panel.locator('.composer-trust')).toHaveText(TRUST);
    await expect(panel.getByText(/No account needed/)).toHaveCount(1);
    const words =
      m === 'test'
        ? 'TipMe is in test mode: no real money moves yet.'
        : 'TipMe is in a pilot. Payments are real.';
    await expect(panel.getByText(words).locator('visible=true')).toHaveCount(1);
    await expect(panel.getByText(/Test payments/)).toHaveCount(0);
    expect((await panel.ariaSnapshot()).split(words).length - 1).toBe(1);
    // Said once, inside the Tip action, in words true for this mode. No provider named.
    const partner = panel.locator('.composer-action__partner');
    await expect(partner).toHaveText(PARTNER[m]);
    await expect(partner).toBeVisible();
    await expect(
      page.locator('.profile-foot').getByText(/partner/),
    ).toHaveCount(0);
    await expect(panel.getByText(/payment partner/)).toHaveCount(1);
    expect((await panel.ariaSnapshot()).split(PARTNER[m]).length - 1).toBe(1);
    expect(await page.locator('body').innerText()).not.toMatch(/bachs/i);
    if (m === 'live') {
      const tip = (await tipButton(page).boundingBox())!;
      const pilot = (await page.getByTestId('pilot-notice').boundingBox())!;
      expect(pilot.y).toBeGreaterThanOrEqual(tip.y + tip.height);
      expect(pilot.y - (tip.y + tip.height)).toBeLessThan(40);
    }
  });

test('a closed page has no card, no trust line, no partner line and no celebration', async ({
  page,
}) => {
  await at('closed', '/@dr7', page);
  await expect(tipButton(page)).toHaveCount(0);
  await expect(page.getByText(TRUST)).toHaveCount(0);
  await expect(page.locator('.composer-action__partner')).toHaveCount(0);
  await expect(page.getByText(/^Celebrating/)).toHaveCount(0);
  await at('live', '/@closedout', page);
  await expect(page.getByText(/^Celebrating/)).toHaveCount(0);
  await expect(page.locator('.composer-action__partner')).toHaveCount(0);
});

test('the celebration is announced in the identity column and the tick box starts unticked', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await at('live', '/@dr7', page);
  const announcement = page
    .locator('[data-profile-card]')
    .getByText('Celebrating DR7’s 10th tip');
  await expect(announcement).toBeVisible();
  await expect(card(page).getByText(/^Celebrating DR7/)).toHaveCount(0);
  const bio = (await page.locator('.profile-bio').boundingBox())!;
  expect((await announcement.boundingBox())!.y).toBeGreaterThanOrEqual(
    bio.y + bio.height - 1,
  );
  await expect(
    page.getByRole('checkbox', { name: 'Add to the celebration' }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Add to the celebration' }),
  ).toHaveCount(0);
  await at('live', '/@kemi', page);
  await expect(
    page.getByRole('checkbox', { name: 'Add to the celebration' }),
  ).toHaveCount(0);
});

test('on a phone the announcement comes before the card @mobile', async ({
  page,
}) => {
  await at('live', '/@dr7', page);
  const announcement = (await page
    .getByText('Celebrating DR7’s 10th tip')
    .boundingBox())!;
  const panel = (await page.locator('[data-tip-panel]').boundingBox())!;
  expect(announcement.y + announcement.height).toBeLessThanOrEqual(panel.y);
});

test('ticking sends celebrationMomentId; ticking then unticking sends nothing', async ({
  page,
}) => {
  for (const tick of [true, false]) {
    const origin = await at('live', '/@dr7', page);
    await page.unrouteAll();
    const sent = await answerApi(page, origin);
    const box = page.getByRole('checkbox', { name: 'Add to the celebration' });
    // Changing your mind counts: ticked then unticked sends nothing.
    await box.check();
    if (!tick) await box.uncheck();
    await page.getByRole('radio', { name: '20,000 NGN' }).click();
    await expect(page.getByText(/You pay/)).toBeVisible();
    await tipButton(page).click();
    await page.waitForURL(/legal\/terms/);
    expect(sent.intents).toHaveLength(1);
    expect(Object.keys(sent.intents[0]!).sort()).toEqual(
      tick ? ['celebrationMomentId', 'quoteId'] : ['quoteId'],
    );
    if (tick)
      expect(sent.intents[0]!.celebrationMomentId).toBe(CELEBRATION.momentId);
  }
});

test('where ₦2,000 is not offered the closest preset starts selected, the lower on a tie, and it does not count as choosing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@kemi', page);
  const sent = await answerApi(page, origin);
  await at('live', '/@dr7', page);
  await expect(page.getByRole('radio', { name: '10,000 NGN' })).toBeChecked();
  await expect(tipButton(page)).toHaveText(/^Tip ₦10,000/);
  await page.waitForTimeout(400);
  expect(sent.quotes).toBe(0);
  expect(sent.events.join()).not.toContain('amount_selected');
  await at('live', '/@tiekeys', page);
  await expect(page.getByRole('radio', { name: '1,500 NGN' })).toBeChecked();
  // The first tap on Tip only asks for the total, as with ₦2,000.
  await tipButton(page).click();
  await expect(page.getByText(/You pay NGN 1,500/)).toBeVisible();
  expect(sent.intents).toEqual([]);
  expect(sent.events.join()).not.toContain('amount_selected');
});

test('at 1280x600 the card stays in view while the left column scrolls, stops at the footer, and shows Tip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await at('live', '/@tallpage', page, { pilotNotice: true });
  const panel = page.locator('[data-tip-panel]');
  await expect(panel).toHaveCSS('position', 'sticky');
  await expect(panel).not.toHaveAttribute('data-taller-than-window');
  await expect(tipButton(page)).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => scrollTo({ top: 500, behavior: 'instant' }));
  await expect(tipButton(page)).toBeInViewport({ ratio: 1 });
  expect((await panel.boundingBox())!.y).toBeLessThan(40);
  await page.evaluate(() =>
    scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
  );
  const foot = (await page.locator('.profile-foot').boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(foot.y);
});

test('a card taller than the window scrolls with the page, keeping the Tip button reachable, with no jump on opening', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await at('live', '/@tallpage', page, { pilotNotice: true });
  const panel = page.locator('[data-tip-panel]');
  await page.evaluate(() => scrollTo({ top: 400, behavior: 'instant' }));
  const before = (await summary(page).boundingBox())!;
  await summary(page).click();
  await expect(panel).toHaveAttribute('data-taller-than-window', '');
  await expect(panel).toHaveCSS('position', 'relative');
  expect(
    Math.abs((await summary(page).boundingBox())!.y - before.y),
  ).toBeLessThanOrEqual(1);
  await tipButton(page).scrollIntoViewIfNeeded();
  await expect(tipButton(page)).toBeInViewport({ ratio: 1 });
  await summary(page).click();
  await expect(panel).not.toHaveAttribute('data-taller-than-window');
});

test('the Tip bar never covers a focused field or an error, on the new fields @mobile', async ({
  page,
}) => {
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 700 });
    const origin = await at('live', '/@dr7', page, { pilotNotice: true });
    await answerApi(page, origin);
    const bar = page.locator('.composer-action');
    const clear = (selector: string) =>
      page.evaluate((target) => {
        const a = document.querySelector('.composer-action')!;
        const b = document.querySelector(target)!.getBoundingClientRect();
        const r = a.getBoundingClientRect();
        return (
          getComputedStyle(a).visibility === 'hidden' ||
          b.bottom <= r.top ||
          b.top >= r.bottom
        );
      }, selector);
    await expect(bar).toBeVisible();
    const field = page.getByLabel(OTHER);
    await field.focus();
    await expect(bar).toBeHidden();
    await field.fill('5');
    await field.blur();
    await expect(bar).toBeVisible();
    await tipButton(page).click();
    await expect(field).toBeFocused();
    await expect(page.locator('.tm-field-error')).toBeInViewport();
    await expect.poll(() => clear('.tm-field-error')).toBe(true);
    await field.fill('');
    await field.blur();
    const tick = page.getByRole('checkbox', { name: 'Add to the celebration' });
    await tick.focus();
    await expect.poll(() => clear('.tip-celebrate')).toBe(true);
    await page.locator('.composer-extras summary').focus();
    await expect.poll(() => clear('.composer-extras summary')).toBe(true);
    await page.keyboard.press('Enter');
    await page.getByLabel('Personal message (optional)').focus();
    await expect(bar).toBeHidden();
    await page.getByLabel('Personal message (optional)').blur();
    // The one on-screen copy of the pilot notice is the bar's, directly above the button.
    await expect(bar.locator('.composer-action__notice')).toContainText(
      'in a pilot',
    );
    await expect(page.getByTestId('pilot-notice')).toBeHidden();
  }
});

test('a long name stays inside the card and the page at every width', async ({
  page,
}) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await at('live', '/@longfirst', page);
    const panel = (await card(page).boundingBox())!;
    const head = (await card(page).locator('h2').boundingBox())!;
    expect(head.x + head.width).toBeLessThanOrEqual(panel.x + panel.width);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByText(/^Celebrating Oluwatobiloba/)).toBeVisible();
  }
});

const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
for (const width of [360, 1280])
  test(`axe finds nothing with the card closed, open and in error at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await at('live', '/@eightkeys', page, { pilotNotice: true });
    const check = async (label: string) => {
      await page.waitForTimeout(300);
      const { violations } = await new AxeBuilder({ page })
        .withTags(wcag)
        .analyze();
      expect(violations.map((v) => `${label} ${v.id}`)).toEqual([]);
    };
    await check('closed');
    await summary(page).click();
    await check('open');
    await page.getByLabel(OTHER).fill('5');
    await page.getByLabel(OTHER).blur();
    await tipButton(page).click();
    await check('error');
  });

test('the Home demo shares the card and still works: disclosure, typed amount, no celebration', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('test', '/', page);
  await answerApi(page, origin);
  const panel = page.locator('.home-hero__panel');
  await expect(
    panel.getByRole('heading', { name: 'Make Ada’s day.' }),
  ).toBeVisible();
  await expect(panel.getByRole('radio', { name: '2,000 NGN' })).toBeChecked();
  await expect(
    panel.getByRole('checkbox', { name: 'Add to the celebration' }),
  ).toHaveCount(0);
  await expect(panel.getByLabel('Personal message (optional)')).toBeHidden();
  await panel.getByText(DISCLOSURE).click();
  await panel.getByLabel('Personal message (optional)').fill('Thanks');
  await panel.getByLabel(OTHER).fill('2500');
  await expect(panel.getByText('You pay NGN 2,500.00')).toBeVisible();
  await expect(
    panel.locator('.composer-action__partner').getByText(PARTNER.test),
  ).toBeVisible();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test('the partner line shows beside Tip on the phone’s first screen, clear of the fold @mobile', async ({
  page,
}) => {
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await at('live', '/@dr7', page, { pilotNotice: true });
    const partner = page.locator('.composer-action .composer-action__partner');
    await expect(partner).toHaveText(PARTNER.live);
    await expect(partner).toBeInViewport({ ratio: 1 });
    expect(await page.locator('[data-tip-panel]').ariaSnapshot()).toContain(
      PARTNER.live,
    );
  }
});

test('Go on a phone’s keyboard never starts a tip with the bar and total hidden @mobile', async ({
  page,
}) => {
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  const bar = page.locator('.composer-action');
  // A typed amount with its total ready: Go only closes the keyboard.
  const field = page.getByLabel(OTHER);
  await field.fill('15000');
  await expect(bar).toBeHidden();
  await expect.poll(() => sent.quotes).toBeGreaterThan(0);
  await page.waitForTimeout(100);
  await field.press('Enter');
  await expect(bar).toBeVisible();
  await expect(field).not.toBeFocused();
  await expect(page.getByText(/You pay NGN 15,000/)).toBeVisible();
  expect(sent.intents).toEqual([]);
  expect(page.url()).toContain('/@dr7');

  // From the preselected amount, in the optional details: the same, twice over.
  await at('live', '/@dr7', page);
  await summary(page).click();
  const name = page.getByLabel('Your name (optional)');
  await name.fill('Ngozi');
  await name.press('Enter');
  await expect(bar).toBeVisible();
  expect(sent.intents).toEqual([]);
  await name.focus();
  await name.press('Enter');
  await expect(bar).toBeVisible();
  expect(sent.intents).toEqual([]);
  expect(page.url()).toContain('/@dr7');
});

test('on desktop Enter in a field works as before: the first asks for the total, the next pays', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  await summary(page).click();
  const name = page.getByLabel('Your name (optional)');
  await name.fill('Ngozi');
  await name.press('Enter');
  await expect(page.getByText(/You pay NGN 10,000/)).toBeVisible();
  expect(sent.intents).toEqual([]);
  await page.waitForTimeout(600);
  await name.press('Enter');
  await page.waitForURL(/legal\/terms/);
  expect(sent.intents).toHaveLength(1);
});

test('a double tap on the preselected amount does not pay the moment the total appears', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  // A second tap in the same moment the total arrives, however fast the answer came.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const button =
          document.querySelector<HTMLButtonElement>('.composer-submit')!;
        const seen = new MutationObserver(() => {
          if (!document.querySelector('.tip-payment-total') || button.disabled)
            return;
          seen.disconnect();
          button.click();
          done();
        });
        seen.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
        });
        button.click();
      }),
  );
  await page.waitForTimeout(200);
  expect(sent.intents).toEqual([]);
  expect(page.url()).toContain('/@dr7');
  // A deliberate tap after that pays as normal.
  await page.waitForTimeout(500);
  await tipButton(page).click();
  await page.waitForURL(/legal\/terms/);
  expect(sent.intents).toHaveLength(1);
});

test('typing an amount counts once, even after a key cleared the first one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  const field = page.getByLabel(OTHER);
  await field.fill('15000');
  await page.getByRole('radio', { name: '20,000 NGN' }).click();
  await field.fill('16000');
  const count = () =>
    sent.events.join().split('custom_amount_entered').length - 1;
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect.poll(count).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(count()).toBe(1);
});

test('when the API says tipping closed after load, the announcement goes with the form', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@dr7', page);
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
  await expect(page.getByText(/^Celebrating DR7/)).toBeVisible();
  await page.getByRole('radio', { name: '20,000 NGN' }).click();
  await expect(
    page.getByRole('heading', { name: 'Tipping opens soon' }),
  ).toBeVisible();
  await expect(page.getByText(/^Celebrating DR7/)).toBeHidden();
});

test('the Other amount example is never below the page’s minimum', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await at('live', '/@dr7', page);
  await expect(page.getByLabel(OTHER)).toHaveAttribute(
    'placeholder',
    'e.g. 10,000',
  );
  await at('live', '/@kemi', page);
  await expect(page.getByLabel(OTHER)).toHaveAttribute(
    'placeholder',
    'e.g. 1,000',
  );
});
