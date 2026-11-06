import { expect, test } from '@playwright/test';

/** Width and height from a PNG's IHDR chunk (bytes 16–23). */
function pngSize(body: Buffer) {
  expect(body.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

test('the home page links a manifest named TipMe and an Apple touch icon', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);

  const response = await request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: 'TipMe',
    short_name: 'TipMe',
    start_url: '/',
    display: 'browser',
    theme_color: '#7A32F9',
    background_color: '#FFFFFF',
  });
  expect(manifest.icons).toEqual([
    {
      src: '/icons/192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/icons/512-maskable.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ]);
});

test('each icon is a PNG of its stated size', async ({ page, request }) => {
  await page.goto('/');
  const apple = await page
    .locator('link[rel="apple-touch-icon"]')
    .getAttribute('href');
  expect(apple).toMatch(/^\/apple-icon/);
  for (const [src, side] of [
    [apple!, 180],
    ['/icons/192.png', 192],
    ['/icons/512-maskable.png', 512],
  ] as const) {
    const response = await request.get(src);
    expect(response.status(), src).toBe(200);
    expect(response.headers()['content-type'], src).toBe('image/png');
    expect(pngSize(await response.body()), src).toEqual({
      width: side,
      height: side,
    });
  }
});

test('the tab icon is still the flat icon.svg', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.locator('link[rel="icon"][type="image/svg+xml"]'),
  ).toHaveAttribute('href', /^\/icon\.svg/);
});

test('an unknown icon file is 404', async ({ request }) => {
  expect((await request.get('/icons/64.png')).status()).toBe(404);
});
