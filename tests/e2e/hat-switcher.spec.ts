import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  accountOf,
  seedBusiness,
  seedBusinessLogo,
  seedMember,
} from './business-fixtures';
import { businessOnlyOwner } from './business-signup-fixtures';
import { expectAccessible, signUpRecipient } from './helpers';

// Business sign-up, Task D6: the account-menu switcher. The business_signup switch is on in the
// e2e stack (seeded from BUSINESS_SIGNUP_ENABLED in playwright.config.ts).

test.slow();

const accountButton = (page: Page) =>
  page.getByRole('main').getByRole('button', { name: /^Account:/ });

test('a page and an owned business: switch to the business from the menu and back', async ({
  page,
}, testInfo) => {
  const me = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(me.email);
  const name = `Suya ${randomUUID().slice(0, 4)}`;
  const business = await seedBusiness({ owner: userId, name });
  await page.goto('/dashboard');
  const button = accountButton(page);
  // The page goes by its username (owner, 16 Nov 2026), not "My page".
  await expect(button).toHaveAccessibleName(`Account: @${me.handle}`, {
    timeout: 20_000,
  });
  await button.click();
  const menu = page.getByRole('menu');
  const you = menu.getByRole('group', { name: 'You', exact: true });
  await expect(you.getByRole('menuitem')).toHaveAccessibleName(
    `@${me.handle} Your page`,
  );
  await expect(menu).not.toContainText('My page');
  await expect(
    menu.getByRole('group', { name: 'Businesses you own' }),
  ).toContainText(name);
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await expectAccessible(page);
  await menu.getByRole('menuitem', { name: new RegExp(name) }).click();
  await page.waitForURL(
    new RegExp(`/dashboard/business\\?business=${business.businessId}$`),
  );
  await expect(accountButton(page)).toHaveAccessibleName(`Account: ${name}`);

  await accountButton(page).click();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: `@${me.handle} Your page` })
    .click();
  await page.waitForURL(/\/dashboard$/);
  await expect(accountButton(page)).toHaveAccessibleName(
    `Account: @${me.handle}`,
  );
});

test('keyboard only: open with Enter, arrows move, Escape closes and returns focus', async ({
  page,
}, testInfo) => {
  const me = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(me.email);
  const name = `Kilishi ${randomUUID().slice(0, 4)}`;
  await seedBusiness({ owner: userId, name, status: 'pending' });
  await page.goto('/dashboard');
  const button = accountButton(page);
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await expect(items.nth(1)).toContainText('Pending');
  await page.keyboard.press('ArrowUp');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  // Into the business by keyboard.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/dashboard\/business\?business=/);
});

test('a business-only login: the menu offers “Turn on your page”, not a page hat', async ({
  page,
}, testInfo) => {
  await businessOnlyOwner(page, testInfo);
  await page.goto('/dashboard/business');
  const button = accountButton(page);
  await expect(button).toHaveAccessibleName('Account: Mama Put Lekki', {
    timeout: 20_000,
  });
  await button.click();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('menuitem', { name: /Turn on your page/ }),
  ).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Your page$/ })).toHaveCount(
    0,
  );
  await expectAccessible(page);
});

// A generated logo (a flat shape, never a real brand), stored as the upload route stores one.
type FromSvg = (svg: Buffer) => { webp(): { toBuffer(): Promise<Buffer> } };
const sharp = createRequire(resolve('apps/api/package.json'))(
  'sharp',
) as FromSvg;
const logoWebp = () =>
  sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#0f766e"/><circle cx="256" cy="256" r="150" fill="#fbbf24"/></svg>',
    ),
  )
    .webp()
    .toBuffer();
const mark = (scope: ReturnType<Page['locator']>) =>
  scope.locator('.hat-menu__initial');

test('a business with a logo shows it in the button and the menu, as owner and as staff; one without shows its initial', async ({
  page,
}, testInfo) => {
  const me = await signUpRecipient(page, testInfo, { live: false });
  const { userId, profileId } = await accountOf(me.email);
  const suffix = randomUUID().slice(0, 4);
  const withLogo = await seedBusiness({
    owner: userId,
    name: `Lagoon Bakery ${suffix}`,
  });
  const logoPath = await seedBusinessLogo(
    withLogo.businessId,
    await logoWebp(),
  );
  await seedBusiness({ owner: userId, name: `Bare Kitchen ${suffix}` });
  // Staff at the same business too: Where I work shows its logo.
  await seedMember({ locationId: withLogo.locations[0]!.id, profileId });

  await page.goto(`/dashboard/business?business=${withLogo.businessId}`);
  const button = accountButton(page);
  await expect(button).toHaveAccessibleName(
    `Account: Lagoon Bakery ${suffix}`,
    { timeout: 20_000 },
  );
  const logo = mark(button).locator('img');
  await expect(logo).toHaveAttribute(
    'src',
    new RegExp(`${logoPath.replaceAll('.', '\\.')}$`),
  );
  await expect
    .poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  expect(await mark(button).boundingBox()).toMatchObject({
    width: 32,
    height: 32,
  });

  await button.click();
  const menu = page.getByRole('menu');
  const row = (name: string) =>
    menu.getByRole('menuitem', { name: new RegExp(name) });
  await expect(
    mark(
      menu
        .getByRole('group', { name: 'Businesses you own' })
        .getByRole('menuitem', { name: /Lagoon Bakery/ }),
    ).locator('img'),
  ).toHaveAttribute('src', new RegExp(`${logoPath.replaceAll('.', '\\.')}$`));
  await expect(
    mark(
      menu
        .getByRole('group', { name: 'Where I work' })
        .getByRole('menuitem', { name: /Lagoon Bakery/ }),
    ).locator('img'),
  ).toHaveCount(1);
  await expect(mark(row('Bare Kitchen'))).toHaveText('B');
  await expect(mark(row('Bare Kitchen')).locator('img')).toHaveCount(0);
  // The page's row: the username, its initial (no photo yet).
  await expect(mark(row(`@${me.handle}`))).toHaveText(
    me.handle[0]!.toUpperCase(),
  );
  await expectAccessible(page);
});

test('a very long business name is cut to the pill’s fixed width, on a phone and a desktop, and never pushes the bar', async ({
  page,
}, testInfo) => {
  const me = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(me.email);
  const name = `Sunrise Republic Trading Company Limited of Lagos and Abuja ${randomUUID().slice(0, 4)}`;
  const business = await seedBusiness({ owner: userId, name });

  for (const { width, maxPill } of [
    { width: 1440, maxPill: 240 },
    { width: 390, maxPill: 192 },
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/dashboard/business?business=${business.businessId}`);
    const button = accountButton(page);
    await expect(button).toHaveAccessibleName(`Account: ${name}`, {
      timeout: 20_000,
    });
    // The full name is there for a pointer, too.
    await expect(button).toHaveAttribute('title', name);
    const box = (await button.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(maxPill);
    const bar = (await page.locator('.dashboard-bar').boundingBox())!;
    // Inside the bar and still at its right edge, where a short name sits.
    expect(box.x + box.width).toBeCloseTo(bar.x + bar.width, 0);
    expect(box.x).toBeGreaterThanOrEqual(bar.x - 0.5);
    // The mark keeps its size; the name is one line, cut with an ellipsis (desktop shows it).
    expect(await mark(button).boundingBox()).toMatchObject({
      width: 32,
      height: 32,
    });
    if (width === 1440) {
      const label = button.locator('.hat-switcher__label');
      const cut = await label.evaluate((el) => ({
        overflow: getComputedStyle(el).textOverflow,
        wraps: getComputedStyle(el).whiteSpace !== 'nowrap',
        clipped: el.scrollWidth > el.clientWidth,
      }));
      expect(cut).toEqual({
        overflow: 'ellipsis',
        wraps: false,
        clipped: true,
      });
    }
    // Nothing scrolls sideways.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    // The menu's row: one line, cut, the same height as a short row, inside the screen.
    await button.click();
    const menu = page.getByRole('menu');
    const long = menu
      .getByRole('menuitem', { name: new RegExp(name) })
      .locator('.hat-menu__name');
    await expect(long).toHaveAttribute('title', name);
    const line = await long.evaluate((el) => ({
      overflow: getComputedStyle(el).textOverflow,
      nowrap: getComputedStyle(el).whiteSpace === 'nowrap',
      clipped: el.scrollWidth > el.clientWidth,
    }));
    expect(line).toEqual({ overflow: 'ellipsis', nowrap: true, clipped: true });
    const short = (await menu
      .getByRole('menuitem', { name: `@${me.handle} Your page` })
      .boundingBox())!;
    const longRow = (await menu
      .getByRole('menuitem', { name: new RegExp(name) })
      .boundingBox())!;
    expect(Math.round(longRow.height)).toBe(Math.round(short.height));
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
  }
});
