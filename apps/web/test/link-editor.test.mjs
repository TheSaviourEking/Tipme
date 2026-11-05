import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addRow,
  editorFrom,
  hiddenStatus,
  legacyPatch,
  notShown,
  moveRow,
  rowProblems,
  setRowUrl,
  shownLinks,
  toRequest,
  toggleFeatured,
} from '../src/lib/link-editor.ts';

const link = (platform, url, featured) => ({
  platform,
  url,
  ...(featured ? { featured: true } : {}),
});
const tt = link('tiktok', 'https://tiktok.com/@ada.edits');
const ig = link('instagram', 'https://instagram.com/ada.edits');
const yt = link('youtube', 'https://youtube.com/@adaedits');
const tw = link('twitch', 'https://twitch.tv/adaedits', true);
const tg = link('telegram', 'https://t.me/adaedits');

test('Free edits only the links that show, and counts the hidden ones', () => {
  const editor = editorFrom({ plan: 'free', links: [tw, tg, tt, ig, yt] });
  assert.deepEqual(
    editor.rows.map((row) => [row.platform, row.featured]),
    [
      ['tiktok', false],
      ['instagram', false],
      ['twitch', false],
    ],
    'catalogue order, unfeatured',
  );
  assert.equal(editor.hidden.length, 2);
  assert.equal(editor.limit, 3);
});

test('an older API: the three fixed links become rows', () => {
  const editor = editorFrom({
    plan: 'free',
    socials: { x: 'https://x.com/ada', facebook: 'https://facebook.com/ada' },
  });
  assert.deepEqual(
    editor.rows.map((row) => row.platform),
    ['facebook', 'x'],
  );
});

test('Free adds in catalogue order; Pro appends, moves and features one', () => {
  let free = editorFrom({ plan: 'free', links: [yt] }).rows;
  free = addRow(free, 'tiktok', 'free');
  assert.deepEqual(
    free.map((row) => row.platform),
    ['tiktok', 'youtube'],
  );
  let pro = editorFrom({ plan: 'pro', links: [yt] }).rows;
  pro = addRow(pro, 'tiktok', 'pro');
  assert.deepEqual(
    pro.map((row) => row.platform),
    ['youtube', 'tiktok'],
  );
  pro = moveRow(pro, 1, -1);
  assert.deepEqual(
    pro.map((row) => row.platform),
    ['tiktok', 'youtube'],
  );
  assert.equal(moveRow(pro, 0, -1), pro, 'nothing above the first');
  pro = toggleFeatured(pro, 1);
  pro = toggleFeatured(pro, 0);
  assert.deepEqual(
    pro.map((row) => row.featured),
    [true, false],
  );
  assert.deepEqual(toRequest(pro, 'pro'), [
    { platform: 'tiktok', url: '', featured: true },
    { platform: 'youtube', url: yt.url },
  ]);
});

test('pasting another site’s link into a row switches the row to that site', () => {
  const rows = addRow([], 'tiktok', 'pro');
  const [row] = setRowUrl(rows, 0, ' https://www.instagram.com/ada ');
  assert.equal(row.platform, 'instagram');
  // A website stays what the owner picked until it is a listed site.
  const site = setRowUrl(addRow([], 'website', 'pro'), 0, 'https://ada.com');
  assert.equal(site[0].platform, 'website');
});

test('each row says what is wrong with it, in plain words', () => {
  const rows = [
    {
      id: 'a',
      platform: 'instagram',
      url: 'https://evil.example/ada',
      featured: false,
    },
    {
      id: 'b',
      platform: 'website',
      url: 'https://linktr.ee/ada',
      featured: false,
    },
    {
      id: 'c',
      platform: 'website',
      url: 'https://instagram.com/ada',
      featured: false,
    },
    { id: 'd', platform: 'tiktok', url: '', featured: false },
    {
      id: 'e',
      platform: 'telegram',
      url: 'https://t.me/adaedits',
      featured: false,
    },
    {
      id: 'f',
      platform: 'telegram',
      url: 'https://t.me/adaedits',
      featured: false,
    },
  ];
  const problems = rowProblems(rows, 'pro');
  assert.match(problems.a, /full https:\/\/ link to your Instagram page/);
  assert.match(problems.b, /Link pages and short links/);
  assert.match(problems.c, /That’s an Instagram link/);
  assert.match(problems.d, /Paste your TikTok link/);
  assert.equal(problems.e, undefined);
  assert.match(
    rowProblems(rows, 'free').e,
    /Telegram links are part of TipMe Pro/,
  );
  assert.match(
    rowProblems(rows, 'free').b,
    /Website links are part of TipMe Pro/,
  );
  assert.match(problems.f, /already/);
  assert.deepEqual(rowProblems(rows.slice(4, 5), 'pro'), {});
});

test('what the page will show while it is being edited', () => {
  const rows = editorFrom({ plan: 'pro', links: [tw, tt, ig] }).rows;
  assert.deepEqual(shownLinks(rows, 'pro'), [tw, tt, ig]);
  assert.deepEqual(
    shownLinks(
      [...rows, { id: 'z', platform: 'x', url: 'nope', featured: false }],
      'pro',
    ),
    [tw, tt, ig],
    'a row that isn’t a usable link yet is left out',
  );
});

test('an older API (no links): Facebook, Instagram and X only, saved through the old profile route', () => {
  const editor = editorFrom({
    plan: 'pro',
    socials: { instagram: 'https://instagram.com/ada' },
  });
  assert.equal(editor.legacy, true);
  assert.deepEqual(editor.sites, ['facebook', 'instagram', 'x']);
  assert.equal(editor.limit, 3, 'three fixed fields, even on Pro');
  const rows = addRow(editor.rows, 'x', 'free', 'https://x.com/ada');
  assert.deepEqual(legacyPatch(rows, false), {
    socials: {
      instagram: 'https://instagram.com/ada',
      x: 'https://x.com/ada',
    },
    socialsPublic: false,
  });
  // A newer API: every allowed site, saved through PUT /v1/me/links.
  const now = editorFrom({ plan: 'free', links: [] });
  assert.equal(now.legacy, false);
  assert.equal(now.sites.includes('tiktok'), true);
  assert.equal(now.sites.includes('telegram'), false, 'Pro sites are Pro');
});

test('Free lists the links kept from Pro, says which will show, and can remove them', () => {
  const stored = [
    tw,
    tg,
    tt,
    ig,
    yt,
    link('onlyfans', 'https://onlyfans.com/ada'),
  ];
  const editor = editorFrom({ plan: 'free', links: stored });
  assert.deepEqual(
    editor.hidden.map((l) => l.platform),
    ['telegram', 'youtube', 'onlyfans'],
  );
  // Nothing removed: the three shown stay, so nothing hidden comes up.
  assert.deepEqual(
    hiddenStatus(stored, editor.rows, editor.hidden).map((s) => s.status),
    ['pro', 'over_limit', 'pro'],
  );
  // Remove Instagram: YouTube (a Free site) moves up, and the editor says so before saving.
  const rows = editor.rows.filter((row) => row.platform !== 'instagram');
  assert.deepEqual(
    hiddenStatus(stored, rows, editor.hidden).map((s) => s.status),
    ['pro', 'will_show', 'pro'],
  );
  // Removing a hidden link drops it from what is kept.
  const kept = editor.hidden.filter((l) => l.platform !== 'onlyfans');
  assert.deepEqual(
    hiddenStatus(stored, rows, kept).map((s) => s.link.platform),
    ['telegram', 'youtube'],
  );
});

test('a returning Pro page with more than 8 says which links do not show', () => {
  const eleven = Array.from({ length: 11 }, (_, i) =>
    link('website', `https://ada${i}.com/`),
  );
  const editor = editorFrom({ plan: 'pro', links: eleven });
  assert.deepEqual(
    notShown(editor.rows, 'pro').map((row) => row.url),
    ['https://ada8.com/', 'https://ada9.com/', 'https://ada10.com/'],
  );
  assert.deepEqual(notShown(editor.rows.slice(0, 8), 'pro'), []);
});

test('with adult-platform links switched off, OnlyFans and Fansly can’t be added', () => {
  const editor = editorFrom({ plan: 'pro', links: [], adultLinks: false });
  assert.equal(editor.sites.includes('onlyfans'), false);
  assert.equal(editor.sites.includes('fansly'), false);
  assert.equal(editor.sites.includes('telegram'), true);
  assert.equal(
    editorFrom({ plan: 'pro', links: [] }).sites.includes('onlyfans'),
    true,
  );
});
