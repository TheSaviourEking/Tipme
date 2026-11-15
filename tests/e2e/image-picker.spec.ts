import { expect, test, type Locator, type Page } from '@playwright/test';
import { accountOf, seedBusiness } from './business-fixtures';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import {
  chooseAndSave,
  chooseImage,
  cropStep,
  jpegOf,
} from './image-picker-helpers';

// One picker for the page photo, a business logo and the cover (owner, 14 Nov 2026): a real
// button, drag and drop on desktop, and a position-and-zoom step before anything is saved.

const photoCard = (page: Page) => page.locator('#photo');
const coverCard = (page: Page) => page.locator('#cover');

/** Every upload or removal the page sends to this address. */
function watchWrites(page: Page, path: string) {
  const sent: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path && request.method() !== 'GET')
      sent.push(request.method());
  });
  return sent;
}

/** The file input stays in the page but is never seen: no "Choose File", no "No file chosen". */
async function expectNoBareInput(page: Page, scope: Locator) {
  await expect(page.getByText('No file chosen')).toHaveCount(0);
  const inputs = scope.locator('input[type="file"]');
  await expect(inputs).toHaveCount(1);
  const box = await inputs.boundingBox();
  expect(box === null || (box.width <= 1 && box.height <= 1)).toBe(true);
}

/** Where the chosen image sits in the frame (its left edge, as the frame's percentage). */
const imageLeft = (step: Locator) =>
  step
    .getByTestId('image-picker-crop-image')
    .evaluate((img: HTMLElement) => parseFloat(img.style.left));

test('the page photo: choose, position, cancel uploads nothing, save shows the new photo', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  const writes = watchWrites(page, '/v1/me/avatar');
  await page.goto('/dashboard/settings');
  const card = photoCard(page);
  await expect(
    card.getByRole('button', { name: 'Choose a photo', exact: true }),
  ).toBeVisible();
  await expectNoBareInput(page, card);
  await expect(card.getByText('or drag one here')).toBeVisible();
  await expect(
    card.getByText(
      'JPEG, PNG or WebP, up to 5 MB. TipMe crops it to a square and removes hidden details such as where it was taken.',
    ),
  ).toBeVisible();

  // A landscape picture: at zoom 1 it can still move sideways in the square frame.
  const file = {
    name: 'me.jpg',
    mimeType: 'image/jpeg',
    buffer: await jpegOf(800, 600),
  };
  await chooseImage(page, card, 'Choose a photo', file);
  const step = cropStep(card, 'photo');
  await expect(step).toBeVisible();
  const frame = step.getByRole('application', { name: 'Photo position' });
  await expect(frame).toBeFocused();
  await expectNoBareInput(page, card);
  await expectAccessible(page);

  // Cancel: nothing was sent, the initials stay, and focus returns to the button.
  await step.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(step).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: 'Choose a photo', exact: true }),
  ).toBeFocused();
  expect(writes).toEqual([]);

  // Keyboard only: zoom with the slider, move with the arrow keys on the frame.
  await chooseImage(page, card, 'Choose a photo', file);
  await expect(step).toBeVisible();
  const zoom = step.getByRole('slider', { name: 'Zoom' });
  await zoom.focus();
  await expect(zoom).toHaveValue('1');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(zoom).toHaveValue('1.2');
  await page.keyboard.press('End');
  await expect(zoom).toHaveValue('4');
  await page.keyboard.press('Home');
  await expect(zoom).toHaveValue('1');
  await frame.focus();
  const centred = await imageLeft(step);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => imageLeft(step)).toBeGreaterThan(centred);
  // As far right as it goes: the image's left edge meets the frame's, never past it.
  for (let i = 0; i < 30; i += 1) await page.keyboard.press('ArrowRight');
  await expect.poll(() => imageLeft(step)).toBe(0);
  expect(writes).toEqual([]);

  await step.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    card.getByRole('status').getByText('Photo saved.'),
  ).toBeVisible();
  expect(writes).toEqual(['PUT']);
  await expect(step).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: 'Change photo', exact: true }),
  ).toBeFocused();
  const shown = card.getByRole('img', { name: /^Photo of / });
  await expect
    .poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expectAccessible(page);
});

test('a file that is too big or not a picture says so in plain words and keeps the photo', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  const writes = watchWrites(page, '/v1/me/avatar');
  await page.goto('/dashboard/settings');
  const card = photoCard(page);

  await chooseImage(page, card, 'Choose a photo', {
    name: 'huge.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(6 * 1024 * 1024, 7),
  });
  await expect(
    card
      .getByRole('alert')
      .getByText('That photo is over 5 MB. Please choose a smaller one.'),
  ).toBeVisible();
  await expect(cropStep(card, 'photo')).toHaveCount(0);
  // The error is tied to the button.
  const button = card.getByRole('button', {
    name: 'Choose a photo',
    exact: true,
  });
  await expect(button).toHaveAccessibleDescription(/over 5 MB/);

  await chooseImage(page, card, 'Choose a photo', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a picture'),
  });
  await expect(
    card
      .getByRole('alert')
      .getByText('Please choose a JPEG, PNG or WebP photo.'),
  ).toBeVisible();
  await expect(cropStep(card, 'photo')).toHaveCount(0);
  expect(writes).toEqual([]);
  await expectAccessible(page);
});

test('a photo that could not be saved can be sent again with Try again', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  let fail = true;
  await page.route('**/v1/me/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me/events') return route.fulfill({ status: 204 });
    if (path === '/v1/me/avatar' && route.request().method() === 'PUT' && fail)
      return route.fulfill({
        status: 503,
        json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'x' } },
      });
    return route.fallback();
  });
  const card = photoCard(page);
  await chooseAndSave(page, card, 'Choose a photo', 'photo', {
    name: 'me.jpg',
    mimeType: 'image/jpeg',
    buffer: await jpegOf(400, 400),
  });
  await expect(
    card
      .getByRole('alert')
      .getByText('We couldn’t save that. Please try again.'),
  ).toBeVisible();
  // The initials stay: nothing was saved.
  await expect(
    card.getByRole('button', { name: 'Choose a photo', exact: true }),
  ).toBeVisible();
  fail = false;
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(
    card.getByRole('status').getByText('Photo saved.'),
  ).toBeVisible();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: 'Try again', exact: true }),
  ).toHaveCount(0);
});

test('dropping a photo on the picker opens the same position step (desktop)', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  const writes = watchWrites(page, '/v1/me/avatar');
  await page.goto('/dashboard/settings');
  const card = photoCard(page);
  const zone = card.getByTestId('image-picker');
  await expect(card.getByText('or drag one here')).toBeVisible();
  const bytes = [...(await jpegOf(300, 300))];
  const transfer = await page.evaluateHandle((data) => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([new Uint8Array(data)], 'dropped.jpg', { type: 'image/jpeg' }),
    );
    return dt;
  }, bytes);
  await zone.dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(zone).toHaveAttribute('data-dropping', 'true');
  await expect(card.getByText('Drop it to use this photo')).toBeVisible();
  await zone.dispatchEvent('drop', { dataTransfer: transfer });
  const step = cropStep(card, 'photo');
  await expect(step).toBeVisible();
  expect(writes).toEqual([]);
  // Cancel brings the picker back without the highlight.
  await step.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(zone).toBeVisible();
  await expect(zone).not.toHaveAttribute('data-dropping', 'true');
  expect(writes).toEqual([]);
});

test('the business logo uses the same picker and step', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  const { userId } = await accountOf(who.email);
  await seedBusiness({ owner: userId, name: 'Kiosk Ade' });
  await page.goto('/dashboard/business');
  const details = page.getByRole('region', { name: 'Details' });
  await expectNoBareInput(page, details);
  const file = {
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: await jpegOf(600, 400, { r: 200, g: 120, b: 20 }),
  };
  await chooseImage(page, details, 'Choose a logo', file);
  const step = cropStep(details, 'logo');
  await expect(step).toBeVisible();
  await step.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(step).toHaveCount(0);
  await expect(
    details.getByRole('button', { name: 'Choose a logo', exact: true }),
  ).toBeFocused();

  await chooseAndSave(page, details, 'Choose a logo', 'logo', file);
  await expect(
    details.getByRole('status').getByText('Logo saved.'),
  ).toBeVisible();
  await expect(
    details.getByRole('button', { name: 'Change logo', exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
});

test('the cover: a wide frame, Cancel sends nothing, Save shows the new cover', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  const writes = watchWrites(page, '/v1/me/cover');
  await page.goto('/dashboard/settings');
  const card = coverCard(page);
  await expectNoBareInput(page, card);
  // A tall phone picture, the case centre-cropping served worst.
  const file = {
    name: 'cover.jpg',
    mimeType: 'image/jpeg',
    buffer: await jpegOf(900, 1600, { r: 31, g: 77, b: 58 }),
  };
  await chooseImage(page, card, 'Upload a cover', file);
  const step = cropStep(card, 'cover');
  await expect(step).toBeVisible();
  // The frame has the saved cover's own shape: 2240 x 600.
  const frame = step.getByRole('application', { name: 'Cover position' });
  const box = (await frame.boundingBox())!;
  expect(Math.abs(box.width / box.height - 2240 / 600)).toBeLessThan(0.05);
  await step.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(step).toHaveCount(0);
  expect(writes).toEqual([]);

  await chooseAndSave(page, card, 'Upload a cover', 'cover', file);
  await expect(
    card.getByRole('status').getByText('Cover saved.'),
  ).toBeVisible();
  expect(writes).toEqual(['PUT']);
  await expect(
    card.getByRole('button', { name: 'Change cover', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      card
        .getByTestId('cover-preview')
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
});

test('at 320px the picker and its step fit, with large controls @mobile', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const card = photoCard(page);
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await chooseImage(page, card, 'Choose a photo', {
      name: 'me.jpg',
      mimeType: 'image/jpeg',
      buffer: await jpegOf(600, 900),
    });
    const step = cropStep(card, 'photo');
    await expect(step).toBeVisible();
    expect(await fitsViewport(page), `page overflows at ${width}px`).toBe(true);
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll('#photo *')]
        .filter(
          (el) =>
            el.getBoundingClientRect().right >
            document.documentElement.clientWidth + 1,
        )
        .map((el) => el.tagName.toLowerCase()),
    );
    expect(clipped, `clipped at ${width}px`).toEqual([]);
    for (const name of ['Save', 'Cancel']) {
      const target = await step
        .getByRole('button', { name, exact: true })
        .boundingBox();
      expect(target!.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoBareInput(page, card);
    await expectAccessible(page);
    await step.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(step).toHaveCount(0);
  }
});

test('on a touch phone the button carries the job: no drag line, and touch drag moves the photo', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 720 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const card = photoCard(page);
  await expect(
    card.getByRole('button', { name: 'Choose a photo', exact: true }),
  ).toBeVisible();
  await expect(card.getByText('or drag one here')).toHaveCount(0);
  await chooseImage(page, card, 'Choose a photo', {
    name: 'me.jpg',
    mimeType: 'image/jpeg',
    buffer: await jpegOf(900, 600),
  });
  const step = cropStep(card, 'photo');
  await expect(step).toBeVisible();
  const frame = step.getByRole('application', { name: 'Photo position' });
  const box = (await frame.boundingBox())!;
  const before = await imageLeft(step);
  // A one-finger drag to the right, as pointer events (what touch produces in the browser).
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await frame.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
  await frame.dispatchEvent('pointermove', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: x + 30,
    clientY: y,
  });
  await frame.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: x + 30,
    clientY: y,
  });
  await expect.poll(() => imageLeft(step)).toBeGreaterThan(before);
  expect(await fitsViewport(page)).toBe(true);
  await context.close();
});
