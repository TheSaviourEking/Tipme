import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';

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
const AUTOMATIC = /^(scattered|large|dark)$/;
const HINT = "If you don't choose, we'll pick one for your page.";

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
    page.getByText('The TipMe team turns Pro on for your page'),
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
