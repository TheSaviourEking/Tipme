import { expect, test } from '@playwright/test';
import { identity, signInWithEmail } from './helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Home, rebuilt to the ScreenHome board (docs/design/redesign/boards/ScreenHome.dc.html).

test('home switches between getting tipped and tipping with one lever', async ({
  page,
}) => {
  await page.goto('/');
  const lever = page.getByRole('radiogroup', { name: 'Show the steps for' });
  const tipped = lever.getByRole('radio', { name: 'If you get tipped' });
  const tipping = lever.getByRole('radio', { name: "If you're tipping" });
  await expect(tipped).toBeChecked();
  const steps = page.locator('main');
  for (const step of ['Make it yours', 'Share it anywhere', 'Get your thanks'])
    await expect(steps.getByText(step, { exact: true })).toBeVisible();
  await expect(steps.getByText('Scan or tap')).toBeHidden();
  await expect(steps.getByText('Say your thanks')).toBeHidden();

  await tipping.click();
  await expect(tipping).toBeChecked();
  for (const step of ['Scan or tap', 'Choose an amount', 'Say your thanks'])
    await expect(steps.getByText(step, { exact: true })).toBeVisible();
  await expect(steps.getByText('Make it yours')).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Tip in three steps.' }),
  ).toBeVisible();

  // One tab stop; the arrow keys move the choice with focus.
  await tipping.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tipped).toBeChecked();
  await expect(tipped).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Tipped in three steps.' }),
  ).toBeVisible();
});

test("the tipping steps' chosen amount reads as chosen on the grey well", async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('radio', { name: "If you're tipping" }).click();
  const chosen = page
    .getByRole('list', { name: "Steps if you're tipping" })
    .locator('.home-key[data-selected="true"]');
  await expect(chosen).toHaveText(/₦5,000/);
  // Its white figures need the purple behind them, not the plain keys' light face.
  expect(
    await chosen.evaluate((key) => getComputedStyle(key).backgroundColor),
  ).not.toBe(
    await page
      .getByRole('list', { name: "Steps if you're tipping" })
      .locator('.home-key:not([data-selected])')
      .first()
      .evaluate((key) => getComputedStyle(key).backgroundColor),
  );
});

test('home states the fee and the minimum plainly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('TipMe keeps 10% of each tip')).toBeVisible();
  await expect(page.getByText('The smallest tip is ₦2,000.')).toBeVisible();
  // Not the old ₦1,000 minimum; Zainab's ₦1,000,000 example is another amount.
  expect(await page.content()).not.toMatch(/₦1,000(?![,\d])/);
});

test('home names global payments, as the owner decided', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-lede')).toContainText(
    'global payments (USD, EUR, GBP, NGN, Stablecoins)',
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Let People Celebrate You for the things you do.',
  );
});

test('the hero tip demo uses the standard amounts', async ({ page }) => {
  await page.goto('/');
  // The example card is a picture of a tip page, so it is hidden from assistive technology.
  const demo = page.locator('.home-demo__main');
  for (const amount of ['₦2,000', '₦5,000', '₦10,000'])
    await expect(demo.getByText(amount, { exact: true })).toBeVisible();
  // The people on it are labelled as examples.
  await expect(page.getByText(/examples, not real people/i)).toBeVisible();
});

test('the handle typed on Home is waiting, lowercased, at the handle step of sign-up', async ({
  page,
}, testInfo) => {
  const who = identity(testInfo);
  // Capitals typed on Home: sign-up lowercases them, as the handle rule requires.
  const typed = who.handle.toUpperCase();
  await page.goto('/');
  const form = page.getByRole('form', { name: 'Claim your link' });
  await form.getByLabel('Your handle').fill(typed);
  await form.getByRole('button', { name: 'Claim your username' }).click();
  await expect(page).toHaveURL(/\/sign-up\?handle=/);
  // Through the email and the code (the handle must survive both) to the handle step.
  await signInWithEmail(page, who.email, page.url());
  const field = page.getByLabel('Handle');
  await expect(field).toHaveValue(who.handle);
  await expect(page.getByText(`@${who.handle} is available`)).toBeVisible();
  // Still editable.
  await field.fill(`${who.handle}_x`);
  await expect(field).toHaveValue(`${who.handle}_x`);
});

test('a handle in the sign-up link that breaks the handle rule prefills nothing', async ({
  page,
}, testInfo) => {
  const who = identity(testInfo);
  await signInWithEmail(page, who.email, '/sign-up?handle=not%20a-handle!');
  await expect(page.getByLabel('Handle')).toBeVisible();
  await expect(page.getByLabel('Handle')).toHaveValue('');
});

test('the claim field says capitals become lowercase', async ({ page }) => {
  await page.goto('/');
  const field = page.getByLabel('Your handle');
  await expect(field).toHaveAttribute('title', /lowercase/);
  expect(
    await field.evaluate((input) => getComputedStyle(input).textTransform),
  ).toBe('lowercase');
});

// The hero's example cards: centred on a phone; alive, flippable and hiding a thank-you wherever
// there is a mouse (the owner's easter egg, 3 Nov 2026). They stay decorative.

test(
  'the example card is centred on a phone @mobile',
  { tag: '@mobile' },
  async ({ page }) => {
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      const box = await page.locator('.home-demo__main').boundingBox();
      expect(box).not.toBeNull();
      const centre = (box?.x ?? 0) + (box?.width ?? 0) / 2;
      expect(Math.abs(centre - width / 2), `${width}px`).toBeLessThanOrEqual(2);
      expect(
        await page
          .locator('.home-demo__caption')
          .evaluate((node) => getComputedStyle(node).textAlign),
      ).toBe('center');
    }
  },
);

const ready = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await expect(page.locator('.home-flip').first()).toHaveAttribute(
    'data-ready',
    'true',
  );
};

test('pressing the example Tip says thank you for the chosen amount, makes no request, then settles', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const ada = page.locator('.home-demo__main');
  await ada.getByText('₦10,000', { exact: true }).click();
  await ada.getByText('Tip ₦10,000').click();
  await expect(ada).toHaveAttribute('data-flipped', 'true');
  await expect(ada.getByText('Thank you for the ₦10,000!')).toBeVisible();
  // Page chrome (link prefetches, the page's own vitals beacon) may talk; nothing about a tip does.
  expect(
    requests.filter(
      (url) => url.startsWith(API_ORIGIN) && !url.endsWith('/v1/vitals'),
    ),
  ).toEqual([]);
  expect(page.url()).toBe(`${WEB_ORIGIN}/`);
  await expect(ada).toHaveAttribute('data-flipped', 'false', {
    timeout: 10_000,
  });
  await ada.getByText('Tip ₦10,000').click();
  await expect(ada.getByText('Thank you for the ₦10,000!')).toBeVisible();
});

// The owner, 3 Nov 2026: "When a card is clicked, the carousel moves and that card becomes
// centered, its only the center card that can flip."
const slots = async (page: import('@playwright/test').Page) => ({
  tobi: await page.locator('.home-demo__card--tobi').getAttribute('data-slot'),
  ada: await page.locator('.home-demo__main').getAttribute('data-slot'),
  zainab: await page
    .locator('.home-demo__card--zainab')
    .getAttribute('data-slot'),
});

/** Clicks the edge of a side card that the centre card leaves clear. */
const clickSide = async (
  page: import('@playwright/test').Page,
  card: import('@playwright/test').Locator,
  side: 'left' | 'right',
) => {
  const box = (await card.boundingBox())!;
  await page.mouse.click(
    side === 'left' ? box.x + 24 : box.x + box.width - 24,
    box.y + box.height / 2,
  );
};

test('clicking a side card turns the carousel to bring it to the centre, without turning it over', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  expect(await slots(page)).toEqual({
    tobi: 'left',
    ada: 'centre',
    zainab: 'right',
  });
  const tobi = page.locator('.home-demo__card--tobi');
  await clickSide(page, tobi, 'left');
  expect(await slots(page)).toEqual({
    tobi: 'centre',
    ada: 'right',
    zainab: 'left',
  });
  await expect(tobi).toHaveAttribute('data-flipped', 'false');
  await clickSide(page, page.locator('.home-demo__main'), 'right');
  expect(await slots(page)).toEqual({
    tobi: 'left',
    ada: 'centre',
    zainab: 'right',
  });
});

test('only the centre card turns over to its note, and it turns back when it leaves the centre', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const tobi = page.locator('.home-demo__card--tobi');
  await clickSide(page, tobi, 'left');
  await tobi.click();
  await expect(tobi).toHaveAttribute('data-flipped', 'true');
  const back = tobi.locator('.home-flip__back');
  await expect(back.getByText('Example', { exact: true })).toBeVisible();
  await expect(back).toContainText('Tobi');
  await tobi.click();
  await expect(tobi).toHaveAttribute('data-flipped', 'false');
  await tobi.click();
  await clickSide(page, page.locator('.home-demo__card--zainab'), 'left');
  await expect(tobi).toHaveAttribute('data-flipped', 'false');
  await expect(page.locator('.home-flip[data-flipped="true"]')).toHaveCount(0);
});

test("Ada's keys and Tip only bring her to the centre while she is to one side", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  await clickSide(page, page.locator('.home-demo__card--tobi'), 'left');
  const ada = page.locator('.home-demo__main');
  await ada.getByText('₦10,000', { exact: true }).dispatchEvent('click');
  expect((await slots(page)).ada).toBe('centre');
  await expect(ada.locator('.home-key[data-selected]')).toHaveText(/₦5,000/);
  await clickSide(page, page.locator('.home-demo__card--zainab'), 'right');
  await ada.getByText('Tip ₦5,000').dispatchEvent('click');
  expect((await slots(page)).ada).toBe('centre');
  await expect(ada).toHaveAttribute('data-flipped', 'false');
  await expect(ada.locator('.home-burst')).toHaveCount(0);
});

// The owner, 3 Nov 2026: "the one in the center should always be the biggest ... They should all
// have amount buttons when in the middle ... and they should have the easter eggs too."
test('the centre card is always the biggest, as the carousel turns', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const cards = {
    tobi: page.locator('.home-demo__card--tobi'),
    ada: page.locator('.home-demo__main'),
    zainab: page.locator('.home-demo__card--zainab'),
  };
  // Both ways: a card can be as wide yet shorter, and the owner saw exactly that.
  const sizes = async () => {
    const at = await slots(page);
    const size = async (name: keyof typeof cards) => {
      const { width, height } = await cards[name].evaluate((node) => {
        const { width, height } = node.getBoundingClientRect();
        return { width, height };
      });
      return { width, height };
    };
    const centre = (Object.keys(at) as (keyof typeof cards)[]).find(
      (name) => at[name] === 'centre',
    )!;
    const others = (Object.keys(at) as (keyof typeof cards)[]).filter(
      (name) => name !== centre,
    );
    return {
      centre: await size(centre),
      sides: await Promise.all(others.map(size)),
    };
  };
  for (const turn of ['start', 'tobi', 'zainab'] as const) {
    if (turn !== 'start') await clickSide(page, cards[turn], 'left');
    const { centre, sides } = await sizes();
    for (const side of sides) {
      expect(centre.width, `${turn}: width`).toBeGreaterThan(side.width);
      expect(centre.height, `${turn}: height`).toBeGreaterThan(side.height);
    }
  }
});

test('every card in the centre has amounts and a Tip, and says its own thank-you', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const tobi = page.locator('.home-demo__card--tobi');
  await clickSide(page, tobi, 'left');
  for (const amount of ['₦2,000', '₦5,000', '₦10,000'])
    await expect(tobi.getByText(amount, { exact: true })).toBeVisible();
  await tobi.getByText('₦10,000', { exact: true }).click();
  await tobi.getByText('Tip ₦10,000').click();
  await expect(tobi).toHaveAttribute('data-flipped', 'true');
  const back = tobi.locator('.home-flip__back');
  await expect(back.getByText('Thank you for the ₦10,000!')).toBeVisible();
  await expect(back).toContainText('Tobi');
});

test("Zainab's example page wears the Pro badge, and the others none", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  await expect(
    page.locator('.home-demo__card--zainab .tm-pro-badge'),
  ).toHaveText('Pro');
  await expect(page.locator('.home-demo__stack .tm-pro-badge')).toHaveCount(1);
});

// The owner, 3 Nov 2026: "zainab's profile should be 100000, 500000, 1000000. You can use 100k,
// 500k and 1M if it'd overflow the card."
test("Zainab's keys are ₦100k, ₦500k and ₦1M, and her Tip and thank-you give the whole amount", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const zainab = page.locator('.home-demo__card--zainab');
  await clickSide(page, zainab, 'right');
  await expect(zainab.locator('.home-key')).toHaveText([
    '₦100k',
    '₦500k',
    '₦1M',
  ]);
  await expect(zainab.locator('.home-key[data-selected]')).toHaveText('₦500k');
  await expect(zainab.getByText('Tip ₦500,000')).toBeVisible();
  for (const key of await zainab.locator('.home-key').all())
    expect(
      await key.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  await zainab.getByText('₦1M', { exact: true }).click();
  await zainab.getByText('Tip ₦1,000,000').click();
  await expect(
    zainab
      .locator('.home-flip__back')
      .getByText('Thank you for the ₦1,000,000!'),
  ).toBeVisible();
});

test("Zainab's cover is her own photo, not one of TipMe's designs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  const src = await page
    .locator('.home-demo__card--zainab .home-demo__cover img')
    .getAttribute('src');
  expect(src).toContain('zainab-sunlit-wall');
  // TipMe's own designs are the covers folder; hers comes from outside it.
  expect(src).not.toContain('covers%2F');
  expect(src).not.toContain('/covers/');
});

// The owner looked in a laptop window narrower than the three-card spread (3 Nov 2026): the lone
// card still answers a mouse there.
test('in a narrower desktop window the lone example card still drifts and says thank you', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  // The suite runs with reduced motion; the drift is only for those who welcome it.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await ready(page);
  const ada = page.locator('.home-demo__main');
  expect(
    await ada.evaluate((node) => getComputedStyle(node).animationName),
  ).toBe('home-drift');
  // A drifting card never holds still for a test's click, so the Tip is pressed with it still.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ada.getByText('Tip ₦5,000').click();
  await expect(ada).toHaveAttribute('data-flipped', 'true');
  await expect(ada.getByText('Thank you for the ₦5,000!')).toBeVisible();
});

test('with reduced motion the example cards have no running animation, and without it they do', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const running = () =>
    page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === 'running' &&
              (a.effect as KeyframeEffect | null)?.target?.closest(
                '.home-demo',
              ),
          ).length,
    );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  expect(await running()).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(running).toBeGreaterThan(0);
});

test('the example cards hold nothing to focus, so assistive technology skips them cleanly', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ready(page);
  await expect(page.locator('.home-demo__stack')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  await expect(
    page
      .locator('.home-demo__stack')
      .locator(
        'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]',
      ),
  ).toHaveCount(0);
});

// The owner, 3 Nov 2026: "We need some activity/animations on the top of this cards when hovered,
// e.g the hearts could react or something."
test("a step's picture moves while the step is hovered, and not otherwise", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const steps = page.getByRole('list', { name: 'Steps if you get tipped' });
  const moving = () =>
    steps.evaluate(
      (list) =>
        list
          .getAnimations({ subtree: true })
          .filter((a) => a.playState === 'running').length,
    );
  expect(await moving()).toBe(0);
  for (const step of await steps.locator('.home-step').all()) {
    await step.hover();
    await expect
      .poll(moving, { message: await step.innerText() })
      .toBeGreaterThan(0);
    await page.mouse.move(0, 0);
    await expect.poll(moving).toBe(0);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await steps.locator('.home-step').first().hover();
  await page.waitForTimeout(300);
  expect(await moving()).toBe(0);
});
