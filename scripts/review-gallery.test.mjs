import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGallery, entriesFromShots } from './review-gallery.mjs';

test('the gallery groups screens and shows desktop and phone side by side', () => {
  const html = buildGallery([
    {
      group: 'Public',
      name: 'Home',
      board: 'ScreenHome',
      desktop: 'public/home-desktop.png',
      phone: 'public/home-phone.png',
    },
    {
      group: 'Public',
      name: 'Pro',
      board: 'PagePro',
      desktop: 'public/pro-desktop.png',
      phone: 'public/pro-phone.png',
    },
  ]);
  assert.equal(html.match(/<h2>Public<\/h2>/g).length, 1);
  assert.match(html, /<img[^>]+src="public\/home-desktop\.png"/);
  assert.match(html, /<img[^>]+src="public\/home-phone\.png"/);
  assert.match(html, /ScreenHome/);
});

test('names are escaped', () => {
  assert.doesNotMatch(
    buildGallery([
      { group: '<b>', name: 'x', board: 'y', desktop: 'a', phone: 'b' },
    ]),
    /<b>/,
  );
});

test('shots taken at each size become one entry per screen, in the order taken', () => {
  assert.deepEqual(
    entriesFromShots([
      {
        group: 'Public',
        name: 'Home',
        board: 'ScreenHome',
        project: 'desktop',
        file: 'public/home-desktop.png',
      },
      {
        group: 'Public',
        name: 'Pro',
        board: 'PagePro',
        project: 'desktop',
        file: 'public/pro-desktop.png',
      },
      {
        group: 'Public',
        name: 'Home',
        board: 'ScreenHome',
        project: 'phone',
        file: 'public/home-phone.png',
      },
    ]),
    [
      {
        group: 'Public',
        name: 'Home',
        board: 'ScreenHome',
        desktop: 'public/home-desktop.png',
        phone: 'public/home-phone.png',
      },
      {
        group: 'Public',
        name: 'Pro',
        board: 'PagePro',
        desktop: 'public/pro-desktop.png',
        phone: undefined,
      },
    ],
  );
});
