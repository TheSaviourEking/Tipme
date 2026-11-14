import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  DANGER_TEXT,
  errorColour,
  expectAccessible,
  fitsViewport,
  signUpRecipient,
} from './helpers';
import { sql } from './ops-helpers';
import { UNBROKEN_NAME } from './profile-fixtures';
import { API_ORIGIN } from './stack';

// Choosing a cover in Settings (design spec §6, motion §7.6). Reduced motion is on in this suite,
// so a choice shows at once; the crossfade timings are in the component and the motion document.
type MakeImage = (options: {
  create: {
    width: number;
    height: number;
    channels: 3;
    background: { r: number; g: number; b: number };
  };
}) => { jpeg(): { toBuffer(): Promise<Buffer> } };
const sharp = createRequire(resolve('apps/api/package.json'))(
  'sharp',
) as MakeImage;

const coverPhoto = () =>
  sharp({
    create: {
      width: 1600,
      height: 500,
      channels: 3,
      background: { r: 31, g: 77, b: 58 },
    },
  })
    .jpeg()
    .toBuffer();

const preview = (page: Page) => page.getByTestId('cover-preview');
const shown = (page: Page) => preview(page).locator('[data-profile-cover]');
const AUTOMATIC = /^(scattered|large|rising)$/;
const HINT = 'If you don’t choose, we’ll pick one for your page.';

/** The public page, seen by a visitor, once it has caught up with the owner's change. */
async function publicCover(browser: Browser, handle: string, want: string) {
  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(visitor.locator('[data-profile-cover]')).toHaveAttribute(
      'data-profile-cover',
      want,
      { timeout: 1000 },
    );
  }).toPass({ timeout: 15_000 });
  await visitor.context().close();
}

test('choosing a design and colour previews at once and shows on the public page after saving', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await expect(
    page.getByRole('heading', { name: 'Cover', exact: true }),
  ).toBeVisible();
  await expect(shown(page)).toHaveAttribute('data-profile-cover', AUTOMATIC);

  await page.getByRole('radio', { name: 'Rippling heart' }).check();
  await expect(shown(page)).toHaveAttribute('data-profile-cover', 'ripple');
  await page.getByRole('radio', { name: 'Forest' }).check();
  await expect(shown(page)).toHaveCSS('background-color', 'rgb(31, 77, 58)');

  // Nothing has been saved yet, so the public page still has the automatic look.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/@${handle}`);
  await expect(visitor.locator('[data-profile-cover]')).toHaveAttribute(
    'data-profile-cover',
    AUTOMATIC,
  );
  await visitor.context().close();

  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expectAccessible(page);
  await publicCover(browser, handle, 'ripple');

  // The choice is what Settings opens on next time.
  await page.reload();
  await expect(
    page.getByRole('radio', { name: 'Rippling heart' }),
  ).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Forest' })).toBeChecked();
  await expect(shown(page)).toHaveCSS('background-color', 'rgb(31, 77, 58)');
});

test('colour choices appear only for designs that take them, with visible names', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const colours = page.getByRole('radiogroup', { name: 'Colour' });

  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect(colours).toHaveCount(0);
  await page.getByRole('radio', { name: 'Indigo Grid' }).check();
  await expect(colours).toHaveCount(0);

  await page.getByRole('radio', { name: 'Scattered hearts' }).check();
  await expect(colours).toBeVisible();
  for (const name of [
    'Neutral',
    'Violet',
    'Lilac',
    'Forest',
    'Ocean',
    'Sun',
    'Rose',
  ]) {
    await expect(colours.getByRole('radio', { name })).toBeAttached();
    // The name is written beside the swatch, not only in the accessible name.
    await expect(colours.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(colours.getByRole('radio', { name: 'Neutral' })).toBeChecked();

  await page.getByRole('radio', { name: 'Danfo' }).check();
  await expect(colours).toHaveCount(0);
});

test('uploading a cover wins over a design; removing it returns to the chosen design', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await page.getByRole('radio', { name: 'Dark' }).check();
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await publicCover(browser, handle, 'dark');

  await page.getByLabel('Upload your own photo').setInputFiles({
    name: 'cover.jpg',
    mimeType: 'image/jpeg',
    buffer: await coverPhoto(),
  });
  await expect(page.getByText('Cover saved.')).toBeVisible();
  // The preview is the stored photo, read from the account's own route (the page needn't be live).
  await expect(shown(page)).toHaveAttribute('data-profile-cover', 'image');
  await expect
    .poll(() =>
      preview(page)
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await publicCover(browser, handle, 'image');

  // A design chosen while a photo shows changes nothing visible: the page says so.
  const note = page.getByTestId('cover-photo-note');
  await expect(note).toContainText('photo is showing');
  await page.getByRole('radio', { name: 'Outlined hearts' }).check();
  await expect(shown(page)).toHaveAttribute('data-profile-cover', 'image');
  await expect(note).toContainText('Outlined hearts');
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(note).toContainText('Remove the photo to show it');
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Remove photo' }).click();
  await expect(page.getByText('Cover removed.')).toBeVisible();
  // The button is gone, and focus doesn't fall to the page body: it moves to the upload control.
  await expect(page.getByLabel('Upload your own photo')).toBeFocused();
  await expect(shown(page)).toHaveAttribute('data-profile-cover', 'outline');
  await expect(note).toHaveCount(0);
  await publicCover(browser, handle, 'outline');
});

test('a bad file shows the same plain errors as photos', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await page.getByRole('radio', { name: 'One large heart' }).check();
  const before = await shown(page).getAttribute('data-profile-cover');
  const upload = page.getByLabel('Upload your own photo');

  await upload.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a picture'),
  });
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Please choose a JPEG, PNG or WebP photo.',
    }),
  ).toBeVisible();
  // An upload has no field edge, so its line keeps the red (PR A review I2).
  expect(
    await errorColour(
      page.getByRole('alert').filter({
        hasText: 'Please choose a JPEG, PNG or WebP photo.',
      }),
    ),
  ).toBe(DANGER_TEXT);

  await upload.setInputFiles({
    name: 'huge.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(6 * 1024 * 1024, 7),
  });
  await expect(
    page.getByRole('alert').filter({
      hasText: 'That photo is over 5 MB. Please choose a smaller one.',
    }),
  ).toBeVisible();
  // A failed upload leaves the cover as it was.
  await expect(shown(page)).toHaveAttribute('data-profile-cover', before ?? '');
});

test('the line about choosing appears until a choice is made', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await expect(page.getByText(HINT)).toBeVisible();
  // Looking at a design is not choosing it.
  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.getByText(HINT)).toBeVisible();
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(page.getByText(HINT)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(HINT)).toHaveCount(0);
});

test('Settings fits at 360px and 320px, with the cover chooser in reach @mobile', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(
      page.getByRole('heading', { name: 'Cover', exact: true }),
    ).toBeVisible();
    expect(await fitsViewport(page), `page overflows at ${width}px`).toBe(true);
    // Nothing inside any card reaches past the screen. The page itself may hide an overflow,
    // so each element is measured: a file input once held the Photo card 402px wide at 360px.
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll('.settings-grid *')]
        .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
        .map(
          (el) =>
            `${el.closest('.settings-section')?.id ?? '?'}/${el.tagName.toLowerCase()}`,
        ),
    );
    expect(clipped, `clipped at ${width}px`).toEqual([]);
    await page.getByRole('radio', { name: 'Scattered hearts' }).check();
    await page.getByRole('radio', { name: 'Rose' }).check();
    await expect(page.getByRole('radio', { name: 'Rose' })).toBeInViewport();
    expect(await fitsViewport(page)).toBe(true);
    await expectAccessible(page);
  }
});

test('a saved design can be given up for the automatic cover', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const automatic = page.getByRole('radio', { name: 'Let TipMe pick' });
  await expect(automatic).toBeChecked();
  await expect(
    page.locator('#pro').getByText('Your page is on the Free plan.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save cover' })).toBeDisabled();
  await page.getByRole('radio', { name: 'Rippling heart' }).check();
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await publicCover(browser, handle, 'ripple');

  await automatic.check();
  await expect(shown(page)).toHaveAttribute('data-profile-cover', AUTOMATIC);
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(page.getByText(HINT)).toBeVisible();
  await publicCover(
    browser,
    handle,
    (await shown(page).getAttribute('data-profile-cover')) ?? '',
  );
  await page.reload();
  await expect(automatic).toBeChecked();
  await expectAccessible(page);
});

test('a photo that fails to save keeps its error line red', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await page.route('**/v1/me/avatar', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'x' } },
        })
      : route.fallback(),
  );
  const photo = await sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: { r: 122, g: 50, b: 249 },
    },
  })
    .jpeg()
    .toBuffer();
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'me.jpg',
    mimeType: 'image/jpeg',
    buffer: photo,
  });
  const line = page.locator('#photo .tm-field-error');
  await expect(line).toBeVisible();
  // No field edge beside it, so it keeps the red until the settings batch (PR A review I2).
  expect(await errorColour(line)).toBe(DANGER_TEXT);
});

test('removing the page photo keeps focus in the Photo card', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const photo = await sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: { r: 122, g: 50, b: 249 },
    },
  })
    .jpeg()
    .toBuffer();
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'me.jpg',
    mimeType: 'image/jpeg',
    buffer: photo,
  });
  await expect(page.getByText('Photo saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove photo' }).click();
  await expect(page.getByText('Photo removed.')).toBeVisible();
  await expect(page.getByLabel('Choose a photo')).toBeFocused();
});

// Settings and the page editor (ScreenSettings): seven sections on one page, each reached by its
// link, and a live preview of the page that follows unsaved edits and saves nothing itself.
const SECTIONS: [string, string][] = [
  ['My page', 'page'],
  ['Make it yours', 'yours'],
  ['Getting paid', 'paid'],
  ['Notifications', 'notifications'],
  ['Sign-in and security', 'security'],
  ['Plan', 'plan'],
  ['Your data and page', 'data'],
];
const supporterPreview = (page: Page) =>
  page.getByRole('complementary', { name: 'Live preview of your page' });

/** Each link reaches its section by its hash; arriving with #paid shows the bank card. */
async function reachEachSection(page: Page) {
  await page.goto('/dashboard/settings');
  const nav = page.locator('nav[aria-label="Settings"]');
  await expect(nav.getByRole('link')).toHaveText(
    SECTIONS.map(([name]) => name),
  );
  for (const [name, id] of SECTIONS) {
    await nav.getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/settings#${id}$`));
    const section = page.locator(`section#${id}`);
    await expect(
      section.getByRole('heading', { level: 2, name, exact: true }),
    ).toBeInViewport();
  }
  // Arriving with the hash: the bank card is there, in its section, on screen.
  await page.goto('/dashboard/settings#paid');
  await expect(
    page.locator('section#paid').getByRole('heading', { name: 'Getting paid' }),
  ).toBeInViewport();
  await expect(
    page.locator('section#paid #get-paid').getByRole('heading', {
      name: 'Get paid',
    }),
  ).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
}

test('settings has seven sections, each reachable by its link', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await reachEachSection(page);
});

test('settings has seven sections on a phone, each reachable by its link @mobile', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await reachEachSection(page);
});

test('the preview shows unsaved edits as you type', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const preview = supporterPreview(page);
  await expect(preview).toContainText('What supporters see');
  await page.getByLabel('Display name').fill('Ada Okafor');
  await page.getByLabel('What you do').fill('Maths tutor');
  await page
    .getByLabel('Bio', { exact: true })
    .fill('I make hard topics feel simple.');
  // Before Save: the preview already shows it.
  await expect(preview).toContainText('Ada Okafor');
  await expect(preview).toContainText('Maths tutor');
  await expect(preview).toContainText('I make hard topics feel simple.');
  await expect(preview).toContainText('Tip Ada');
  // Nothing was saved: after a reload neither the form nor the preview has it.
  await page.reload();
  await expect(page.getByLabel('What you do')).toHaveValue('');
  await expect(supporterPreview(page)).not.toContainText('Maths tutor');
});

test('the preview offers the page’s real amounts', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const keys = supporterPreview(page).getByRole('listitem');
  await expect(keys).toHaveText(['₦2,000', '₦5,000', '₦10,000']);
  await expect(supporterPreview(page)).not.toContainText('₦1,000');
  // A Pro page with its own amounts: the preview offers those, as the API sends them.
  await page.route(`${API_ORIGIN}/v1/me/profile`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        data: {
          ...body.data,
          plan: 'pro',
          tipAmounts: {
            presetsMinor: ['300000', '750000'],
            minMinor: '250000',
          },
        },
      },
    });
  });
  await page.reload();
  await expect(supporterPreview(page).getByRole('listitem')).toHaveText([
    '₦3,000',
    '₦7,500',
  ]);
});

test('settings fits a long unbroken name at 320px @mobile', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await page.getByLabel('Display name').fill(UNBROKEN_NAME);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.reload();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(supporterPreview(page)).toContainText(UNBROKEN_NAME);
  expect(await fitsViewport(page), 'page overflows at 320px').toBe(true);
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('.settings-grid *')]
      .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
      .map(
        (el) =>
          `${el.closest('section[id]')?.id ?? '?'}/${el.tagName.toLowerCase()}.${el.className}`,
      ),
  );
  expect(clipped, 'clipped at 320px').toEqual([]);
  // The section links and the Save button stay clear of the phone's tab bar.
  const save = page.getByRole('button', { name: 'Save changes' });
  await save.scrollIntoViewIfNeeded();
  const [saveBox, bar] = await Promise.all([
    save.boundingBox(),
    page.locator('nav[aria-label="Dashboard"]').boundingBox(),
  ]);
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(bar!.y);
  await expectAccessible(page);
});

// Animated covers (owner's decision, 2 Nov 2026): three on Free that play once; on Pro, all six in
// any colour, played once or on a slow loop. The server holds the lock; this is the chooser.
const animated = (page: Page) =>
  page.getByRole('radiogroup', { name: 'Animated covers' });
const playing = (page: Page) =>
  page.getByRole('radiogroup', { name: 'How it plays' });
const setPlan = (handle: string, plan: 'free' | 'pro') =>
  sql('UPDATE profiles SET plan = $2 WHERE handle_lower = $1', [
    handle.toLowerCase(),
    plan,
  ]);
async function publicPlay(browser: Browser, handle: string, want: string) {
  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(visitor.locator('[data-profile-cover]')).toHaveAttribute(
      'data-cover-play',
      want,
      { timeout: 1000 },
    );
  }).toPass({ timeout: 15_000 });
  await visitor.context().close();
}

test('Free sees Drifting, Rising and Ripple, and Pro designs marked "Pro"', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const group = animated(page);
  for (const name of ['Drifting', 'Rising', 'Ripple'])
    await expect(group.getByRole('radio', { name })).not.toContainText('Pro');
  for (const name of ['Pulse', 'Night sky', 'Sunrise']) {
    const choice = group.locator('label', { hasText: name });
    await expect(choice.getByText('Pro', { exact: true })).toBeVisible();
  }
  await group.locator('label', { hasText: 'Pulse' }).click();
  await expect(
    page.getByText(
      'Pulse comes with Pro. Free includes Drifting, Rising and Ripple.',
    ),
  ).toBeVisible();
  for (const radio of await group.getByRole('radio').all())
    await expect(radio).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Save cover' })).toBeDisabled();
});

test('Free: Slow loop is aria-disabled and explains itself', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await animated(page).getByRole('radio', { name: 'Drifting' }).check();
  const loop = playing(page).getByRole('radio', { name: 'Slow loop' });
  await expect(loop).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled, not disabled: it stays focusable, so it can explain itself.
  expect(await loop.evaluate((el) => (el as HTMLInputElement).disabled)).toBe(
    false,
  );
  await loop.focus();
  await expect(loop).toBeFocused();
  await loop.click({ force: true });
  await expect(
    page.getByText(
      'Slow loop comes with Pro. On Free, animated covers play once when your page opens.',
    ),
  ).toBeVisible();
  await expect(
    playing(page).getByRole('radio', { name: 'Plays once' }),
  ).toBeChecked();
});

test('Free saves Drifting; the public page plays it once', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await animated(page).getByRole('radio', { name: 'Drifting' }).check();
  await expect(shown(page)).toHaveAttribute(
    'data-profile-cover',
    'animated:drift',
  );
  await expect(page.getByRole('radiogroup', { name: 'Colour' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await publicPlay(browser, handle, 'once');
  await page.reload();
  await expect(
    animated(page).getByRole('radio', { name: 'Drifting' }),
  ).toBeChecked();
});

test('Pro chooses Night sky, Ocean and Slow loop; the public page loops', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await setPlan(handle, 'pro');
  await page.goto('/dashboard/settings');
  await animated(page).getByRole('radio', { name: 'Night sky' }).check();
  await page
    .getByRole('radiogroup', { name: 'Colour' })
    .getByRole('radio', { name: 'Ocean' })
    .check();
  await playing(page).getByRole('radio', { name: 'Slow loop' }).check();
  await expect(shown(page)).toHaveCSS('background-color', 'rgb(29, 78, 137)');
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await publicPlay(browser, handle, 'loop');
  await page.reload();
  await expect(
    playing(page).getByRole('radio', { name: 'Slow loop' }),
  ).toBeChecked();
});

test('a refused save (the plan dropped) says so and keeps the saved cover', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await setPlan(handle, 'pro');
  await page.goto('/dashboard/settings');
  await animated(page).getByRole('radio', { name: 'Drifting' }).check();
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await setPlan(handle, 'free');
  await animated(page).getByRole('radio', { name: 'Night sky' }).check();
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(
    page.getByText('This cover choice is part of TipMe Pro.'),
  ).toBeVisible();
  await publicCover(browser, handle, 'animated:drift');
  await expect(
    animated(page).getByRole('radio', { name: 'Drifting' }),
  ).toBeChecked();
});

test('the chooser fits 320px and 360px with no overflow, and every control is at least 44px @mobile', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await setPlan(handle, 'pro');
  await page.goto('/dashboard/settings');
  await animated(page).getByRole('radio', { name: 'Night sky' }).check();
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await fitsViewport(page), `${width}px`).toBe(true);
    const small = await page
      .locator(
        '#cover label.cover-choice, #cover label.cover-colour, #cover label.cover-motion',
      )
      .evaluateAll((labels) =>
        labels
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height < 44 || r.width < 44)
          .map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`),
      );
    expect(small, `${width}px`).toEqual([]);
  }
});

test('a page that left Pro opens as plays once, and saving again clears the Pro settings', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await setPlan(handle, 'pro');
  await page.goto('/dashboard/settings');
  await animated(page).getByRole('radio', { name: 'Drifting' }).check();
  await page
    .getByRole('radiogroup', { name: 'Colour' })
    .getByRole('radio', { name: 'Ocean' })
    .check();
  await playing(page).getByRole('radio', { name: 'Slow loop' }).check();
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await setPlan(handle, 'free');
  await page.reload();
  await expect(
    playing(page).getByRole('radio', { name: 'Plays once' }),
  ).toBeChecked();
  await expect(
    playing(page).getByRole('radio', { name: 'Slow loop' }),
  ).not.toBeChecked();
  // It still holds the loop and colour, so saving is offered, and it clears them.
  const save = page.getByRole('button', { name: 'Save cover' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const [row] = await sql<{
    cover_motion: string | null;
    cover_colour: string | null;
  }>(
    'SELECT cover_motion, cover_colour FROM profiles WHERE handle_lower = $1',
    [handle.toLowerCase()],
  );
  expect(row).toEqual({ cover_motion: null, cover_colour: null });
  await expect(save).toBeDisabled();
});

test('a Pro animation on a page that left Pro says it shows as a still picture', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await setPlan(handle, 'pro');
  await page.goto('/dashboard/settings');
  await animated(page).getByRole('radio', { name: 'Night sky' }).check();
  await page.getByRole('button', { name: 'Save cover' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await setPlan(handle, 'free');
  await page.reload();
  await expect(
    page.getByText(
      'Your page is on Free, so Night sky shows as a still picture. Choose Drifting, Rising or Ripple to play it.',
    ),
  ).toBeVisible();
});
