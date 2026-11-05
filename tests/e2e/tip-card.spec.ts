import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  CELEBRATION,
  startStack,
  type Mode,
  type Stack,
} from './profile-fixtures';
import { DANGER_TEXT, PLAIN_TEXT, errorColour, hasRedEdge } from './helpers';

// The owner-approved compact tip card (2 Nov 2026), on the built web app against the stand-in API.
// Calls the browser makes for prices and tips are answered here: nothing reaches any provider.

const TRUST = 'No account needed. You pay exactly this amount.';
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
async function answerApi(
  page: Page,
  origin: string,
  overrides: Record<string, string> = {},
) {
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
          ...overrides,
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
  // The red is in the field's edge (the tip card's own input rules keep it); the line is black.
  expect(await hasRedEdge(field)).toBe(true);
  expect(await errorColour(page.getByText(/^Enter an amount of NGN/))).toBe(
    PLAIN_TEXT,
  );
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
  // One tap on Tip pays, with no total step, and the starting amount still isn't a person choosing.
  await tipButton(page).click();
  await expect.poll(() => sent.intents.length).toBe(1);
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

test('Go on a phone’s keyboard never starts a tip with the bar hidden @mobile', async ({
  page,
}) => {
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  const bar = page.locator('.composer-action');
  // Go only closes the keyboard: the person sees the Tip button and its amount before paying.
  const field = page.getByLabel(OTHER);
  await field.fill('15000');
  await expect(bar).toBeHidden();
  await field.press('Enter');
  await expect(bar).toBeVisible();
  await expect(field).not.toBeFocused();
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

test('on desktop Enter in a field pays the amount shown, as the button does', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  await summary(page).click();
  const name = page.getByLabel('Your name (optional)');
  await name.fill('Ngozi');
  await name.press('Enter');
  await page.waitForURL(/legal\/terms/);
  expect(sent.intents).toHaveLength(1);
});

test('one tap pays: a page view and choosing quote nothing, the tap quotes then starts, and a double tap starts one tip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  await page.getByRole('radio', { name: '20,000 NGN' }).click();
  await page.getByLabel(OTHER).fill('15000');
  await page.getByRole('radio', { name: '20,000 NGN' }).click();
  await page.waitForTimeout(400);
  expect(sent.quotes).toBe(0);
  await tipButton(page).dblclick();
  await page.waitForURL(/legal\/terms/);
  expect(sent.quotes).toBe(1);
  expect(sent.intents).toHaveLength(1);
  expect(sent.intents[0]!.quoteId).toBe('22222222-2222-4222-8222-222222222222');
});

for (const [what, wrong] of [
  ['payer total', { payerTotalMinor: '2500000' }],
  ['tip amount', { tipMinor: '1000000' }],
] as const)
  test(`a server ${what} that differs from the amount shown stops before charging`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const origin = await at('live', '/@dr7', page);
    const sent = await answerApi(page, origin, wrong);
    await tipButton(page).waitFor();
    await page.waitForTimeout(300);
    await page.getByRole('radio', { name: '20,000 NGN' }).click();
    await tipButton(page).click();
    await expect(
      page.locator('.tip-quote').getByText(/nothing was charged/i),
    ).toBeVisible();
    await page.waitForTimeout(300);
    expect(sent.intents).toEqual([]);
    expect(page.url()).toContain('/@dr7');
  });

test('a quote that fails on the tap offers a retry, and the retry pays once', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  let fail = true;
  await page.route('**/v1/tip-quotes', (route) =>
    fail ? route.abort() : route.fallback(),
  );
  await tipButton(page).click();
  await expect(
    page
      .locator('.tip-quote')
      .getByText(
        'We couldn’t reach TipMe. Check your connection and try again.',
      ),
  ).toBeVisible();
  // No field edge beside this line, so it keeps its red until the public batch.
  expect(
    await errorColour(page.locator('.tip-quote .tm-field-error').first()),
  ).toBe(DANGER_TEXT);
  expect(sent.intents).toEqual([]);
  await expect(tipButton(page)).toBeEnabled();
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForURL(/legal\/terms/);
  expect(sent.intents).toHaveLength(1);
});

test('a retry after an unknown outcome replays the same tip, never a second one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@dr7', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  const keys: string[] = [];
  let first = true;
  await page.route('**/v1/tip-intents', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (first) {
      first = false;
      return route.fulfill({
        status: 502,
        headers: { 'access-control-allow-origin': origin },
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'PROVIDER_OUTCOME_UNKNOWN' } }),
      });
    }
    return route.fallback();
  });
  await tipButton(page).click();
  await expect(
    page.getByText(/We couldn’t confirm whether your payment started/),
  ).toBeVisible();
  await tipButton(page).click();
  await page.waitForURL(/legal\/terms/);
  expect(sent.quotes).toBe(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
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
  await tipButton(page).click();
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
    'e.g. 2,000',
  );
});

// States plan, Task 9: the tip form's Not sent slip, its proven safe line, and the amount flag.
test('a tip that could not reach TipMe shows the Not sent slip under Tip, keeps the amount, and Try again replays the same key', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@kemi', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  const keys: string[] = [];
  let fail = true;
  await page.route('**/v1/tip-intents', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    return fail ? route.abort() : route.fallback();
  });
  await page.getByRole('radio', { name: '5,000 NGN' }).check();
  await tipButton(page).click();
  const slip = page.locator('.appreciation-card .tm-slip');
  await expect(slip).toHaveAttribute('role', 'alert');
  await expect(slip).toContainText('Not sent yet');
  await expect(slip).toContainText(
    'We couldn’t reach TipMe. Check your connection and try again.',
  );
  await expect(slip.locator('.tm-slip__safe')).toHaveText(
    'You haven’t paid anything.',
  );
  await expect(page.locator('.appreciation-card .tm-notice')).toHaveCount(0);
  // It comes out from under the Tip button.
  const slipBox = await slip.boundingBox();
  const tipBox = await tipButton(page).boundingBox();
  expect(slipBox!.y).toBeGreaterThan(tipBox!.y);
  await expect(page.getByRole('radio', { name: '5,000 NGN' })).toBeChecked();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  // The first tap was tried twice (one quiet retry, Task 16), with one key.
  expect(keys).toHaveLength(2);
  fail = false;
  await slip.getByRole('button', { name: 'Try again' }).click();
  await page.waitForURL(/legal\/terms/);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  expect(sent.intents).toHaveLength(1);
});

test('a refusal that reached TipMe shows the slip without the safe line', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@kemi', page);
  await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  for (const code of ['DEPENDENCY_UNAVAILABLE', 'PROVIDER_OUTCOME_UNKNOWN']) {
    await page.route('**/v1/tip-intents', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fallback();
      return route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': origin },
        contentType: 'application/json',
        body: JSON.stringify({ error: { code } }),
      });
    });
    await tipButton(page).click();
    const slip = page.locator('.appreciation-card .tm-slip');
    await expect(slip, code).toBeVisible();
    await expect(slip, code).toContainText('Not sent yet');
    await expect(slip.locator('.tm-slip__safe'), code).toHaveCount(0);
    await page.unroute('**/v1/tip-intents');
  }
});

test('below the minimum: a red edge and the reason beside the number, one plain line, and the nearest amount lights up', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@kemi', page);
  const sent = await answerApi(page, origin);
  const field = page.getByLabel(OTHER);
  const suggested = page
    .getByRole('radio', { name: '2,000 NGN' })
    .locator('xpath=ancestor::label[contains(@class, "tm-amount-choice")]');
  const resting = await field.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await expect(suggested).not.toHaveAttribute('data-suggested', 'true');
  await field.fill('1500');
  await field.blur();
  await tipButton(page).click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.appreciation-card .tm-field-flag')).toHaveText(
    'below 2,000',
  );
  await expect(page.locator('.appreciation-card .tm-field-error')).toHaveText(
    /^Enter an amount of NGN 2,000 or more/,
  );
  expect(await hasRedEdge(field)).toBe(true);
  await expect(suggested).toHaveAttribute('data-suggested', 'true');
  // Only the key at the minimum lights up.
  await expect(
    page.locator('.appreciation-card [data-suggested="true"]'),
  ).toHaveCount(1);
  // No pink fill: the well keeps its own colour.
  await field.blur();
  expect(
    await field.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe(resting);
  expect(sent.intents).toEqual([]);
  // A mistyped amount is not "below" anything: the line shows, the flag and the light don't.
  await field.fill('12,34');
  await field.blur();
  await tipButton(page).click();
  await expect(
    page.locator('.appreciation-card .tm-field-error'),
  ).toBeVisible();
  await expect(page.locator('.appreciation-card .tm-field-flag')).toHaveCount(
    0,
  );
  await expect(
    page.locator('.appreciation-card [data-suggested="true"]'),
  ).toHaveCount(0);
  // Choosing the lit key clears it all.
  await field.fill('1500');
  await field.blur();
  await tipButton(page).click();
  await expect(suggested).toHaveAttribute('data-suggested', 'true');
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(page.locator('.appreciation-card .tm-field-error')).toHaveCount(
    0,
  );
  await expect(
    page.locator('.appreciation-card [data-suggested="true"]'),
  ).toHaveCount(0);
});

test('at 320px the flag and the slip fit, with long and unbroken names @mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  for (const handle of ['longname', 'widename']) {
    const origin = await at('live', `/@${handle}`, page);
    await answerApi(page, origin);
    const field = page.getByLabel(OTHER);
    await field.fill('1500');
    await field.blur();
    await tipButton(page).click();
    const flag = page.locator('.appreciation-card .tm-field-flag');
    await expect(flag).toBeVisible();
    // The typed value ends before the flag starts.
    const [fieldBox, flagBox] = await Promise.all([
      field.boundingBox(),
      flag.boundingBox(),
    ]);
    const padEnd = await field.evaluate((el) =>
      parseFloat(getComputedStyle(el).paddingInlineEnd),
    );
    expect(fieldBox!.x + fieldBox!.width - padEnd).toBeLessThanOrEqual(
      flagBox!.x + 1,
    );
    await page.route('**/v1/tip-intents', (route) =>
      route.request().method() === 'OPTIONS' ? route.fallback() : route.abort(),
    );
    await page.getByRole('radio', { name: '2,000 NGN' }).check();
    await tipButton(page).click();
    await expect(page.locator('.appreciation-card .tm-slip')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      handle,
    ).toBe(true);
    await page.unroute('**/v1/tip-intents');
  }
});

// States plan, Task 16: one quiet retry where it is safe, and a send on reconnect.
const OFFLINE = 'We couldn’t reach TipMe. Check your connection and try again.';
const DROPPED = OFFLINE;
const DROPPED_SAFE_LINES = 1;
/** Counts tip intents by idempotency key; `plan` says what each attempt does. */
async function intentsBy(
  page: Page,
  plan: (attempt: number) => 'abort' | 'fallback',
) {
  const keys: string[] = [];
  await page.route('**/v1/tip-intents', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    return plan(keys.length) === 'abort' ? route.abort() : route.fallback();
  });
  return keys;
}

test('a dropped connection is retried once quietly with the same key, and the tip goes through', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@kemi', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  const keys = await intentsBy(page, (n) => (n === 1 ? 'abort' : 'fallback'));
  // Any slip that ever appears is remembered, even if the page leaves at once.
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (document.querySelector('.tm-slip'))
        sessionStorage.setItem('saw-slip', '1');
    }).observe(document.body, { childList: true, subtree: true });
  });
  await tipButton(page).click();
  await page.waitForURL(/legal\/terms/);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(sent.intents).toHaveLength(1);
  expect(await page.evaluate(() => sessionStorage.getItem('saw-slip'))).toBe(
    null,
  );
});

test('two dropped connections show the Not sent slip with the safe line; Try again replays the same key', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@kemi', page);
  await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  const keys = await intentsBy(page, (n) => (n <= 2 ? 'abort' : 'fallback'));
  await tipButton(page).click();
  const slip = page.locator('.appreciation-card .tm-slip');
  await expect(slip).toContainText('Not sent yet');
  await expect(slip).toContainText(DROPPED);
  await expect(slip.locator('.tm-slip__safe')).toHaveCount(DROPPED_SAFE_LINES);
  expect(keys).toHaveLength(2);
  await slip.getByRole('button', { name: 'Try again' }).click();
  await page.waitForURL(/legal\/terms/);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
});

test('offline at the tap: nothing is sent, the slip says so, and the tip goes on reconnect', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@kemi', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  await context.setOffline(true);
  await tipButton(page).click();
  const slip = page.locator('.appreciation-card .tm-slip');
  await expect(slip).toContainText('Not sent yet');
  await expect(slip).toContainText(OFFLINE);
  // Nothing was sent, so this one is proven.
  await expect(slip.locator('.tm-slip__safe')).toHaveText(
    'You haven’t paid anything.',
  );
  expect(sent.quotes).toBe(0);
  expect(sent.intents).toHaveLength(0);
  await context.setOffline(false);
  await page.waitForURL(/legal\/terms/);
  expect(sent.intents).toHaveLength(1);
});

test('changing the amount while offline cancels the send on reconnect', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const origin = await at('live', '/@kemi', page);
  const sent = await answerApi(page, origin);
  await tipButton(page).waitFor();
  await page.waitForTimeout(300);
  await context.setOffline(true);
  await tipButton(page).click();
  await expect(page.locator('.appreciation-card .tm-slip')).toBeVisible();
  await page.getByRole('radio', { name: '5,000 NGN' }).check();
  await context.setOffline(false);
  await page.waitForTimeout(1000);
  expect(sent.quotes).toBe(0);
  expect(sent.intents).toHaveLength(0);
  expect(page.url()).toMatch(/\/@kemi$/);
});
