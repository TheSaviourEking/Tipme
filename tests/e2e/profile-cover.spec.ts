import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The cover artwork is served by the web app itself, so a page never waits on another origin for
// it. These checks cover the files; profile-page.spec.ts has the page-level ones.
const covers = readdirSync('apps/web/public/covers')
  .filter((file) => file.endsWith('.webp'))
  .map((file) => file.replace(/\.webp$/, ''));

test('every pattern cover is served as a small WebP from this site', async ({
  request,
}) => {
  expect(covers).toHaveLength(18);
  for (const id of covers) {
    const response = await request.get(`/covers/${id}.webp`);
    expect(response.status(), id).toBe(200);
    expect(response.headers()['content-type'], id).toBe('image/webp');
    expect((await response.body()).length, id).toBeLessThanOrEqual(120 * 1024);
  }
});

test('a name that is not a cover is not served', async ({ request }) => {
  expect((await request.get('/covers/nope.webp')).status()).toBe(404);
});
