import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGallery,
  entriesFromShots,
  parseStamp,
} from './review-gallery.mjs';
import { readStamp } from './review-stamp.mjs';

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

test('the page header shows the commit it was built from and when', () => {
  const html = buildGallery([], {
    sha: 'abc1234',
    dirty: true,
    builtAt: '2026-11-03 14:05',
  });
  assert.match(html, /Built from abc1234 \+ uncommitted changes/);
  assert.match(html, /2026-11-03 14:05/);
  assert.doesNotMatch(
    buildGallery([], { sha: 'abc1234', dirty: false, builtAt: 'now' }),
    /uncommitted/,
  );
});

test('without a stamp the header says the build is unknown, never a guess', () => {
  const html = buildGallery([]);
  assert.match(html, /Built from: unknown/);
  assert.doesNotMatch(html, /Built from [0-9a-f]{7}/);
});

test('a stamp file is read back as written, and a missing or broken one is unknown', () => {
  const stamp = { sha: 'abc1234', dirty: false, builtAt: '2026-11-03 14:05' };
  assert.deepEqual(parseStamp(JSON.stringify(stamp)), stamp);
  assert.equal(parseStamp(undefined), undefined);
  assert.equal(parseStamp('not json'), undefined);
  assert.equal(parseStamp('{"sha":1}'), undefined);
});

test('the stamp is taken from git when the shots are taken: short commit, edits, time', () => {
  const calls = [];
  const git = (...args) => {
    calls.push(args.join(' '));
    return args[0] === 'rev-parse' ? 'abc1234\n' : ' M a.ts\n';
  };
  const stamp = readStamp(git, new Date('2026-11-03T14:05:59Z'));
  assert.deepEqual(stamp, {
    sha: 'abc1234',
    dirty: true,
    builtAt: '2026-11-03 14:05 UTC',
  });
  assert.deepEqual(calls, ['rev-parse --short HEAD', 'status --porcelain']);
  assert.equal(readStamp(() => '', new Date(0)).dirty, false);
});
