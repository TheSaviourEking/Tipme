import { deflateSync, crc32 } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { signUpRecipient } from './helpers';

// Both flows go through the real browser: its WebP encoder (which always adds a colour
// profile) and its cross-origin rules are exactly what unit tests can't see.

/** A 640×800 gradient PNG, as a phone photo stand-in (no image library needed). */
function photoPng(): Buffer {
  const [w, h] = [640, 800];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const at = y * (w * 3 + 1) + 1 + x * 3;
      raw[at] = 200 - (y % 200);
      raw[at + 1] = 120 + (x % 100);
      raw[at + 2] = 90;
    }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 2], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a recipient adds a photo, it shows on their page, and they can remove it', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: photoPng(),
  });
  await expect(
    page.getByText('Saved. Your page shows your new photo.'),
  ).toBeVisible({ timeout: 20_000 });

  await page.goto(`/@${who.handle}`);
  await expect(
    page.getByRole('img', { name: `Photo of ${who.handle}` }),
  ).toBeVisible();
  const path = (
    await page.request.get(`/@${who.handle}`).then((r) => r.text())
  ).match(/\/avatars\/[0-9a-f-]+\.webp/)?.[0];
  expect(path).toBeTruthy();
  const served = await page.request.get(path ?? '');
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('image/webp');
  // Stored without the browser's colour profile or any other metadata.
  expect((await served.body()).includes('ICCP')).toBe(false);

  await page.goto('/dashboard/settings');
  await page.getByRole('button', { name: 'Remove photo' }).click();
  await expect(page.getByRole('button', { name: 'Add a photo' })).toBeVisible();
  await page.goto(`/@${who.handle}`);
  await expect(
    page.getByRole('img', { name: `Portrait unavailable for ${who.handle}` }),
  ).toBeVisible();
});

test('a visitor reports a page without an account', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/@ada');
  await page.getByText('Report this page').click();
  await page.getByRole('radio', { name: 'A scam or misleading page' }).check();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(
    page.getByText('Thank you. TipMe will look into this page.'),
  ).toBeVisible();
  await context.close();
});
