import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  claimHandle,
  getMyProfile,
  listPretendOutbox,
  publicProfile,
  requestSignInCode,
  setMyLinks,
  setPageState,
  updateMyProfile,
  verifySignInCode,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Social links (SocialLinks board, owner 5 Nov 2026): Free 3 from Free sites in catalogue
// order; Pro 8, own order, one featured; a lapsed Pro page hides the extras and keeps them.

const secret = 'test-auth-code-secret-at-least-32-chars!';
const now = new Date('2026-11-05T10:00:00Z');
const link = (platform, url, featured) => ({
  platform,
  url,
  ...(featured ? { featured: true } : {}),
});
const tt = link('tiktok', 'https://tiktok.com/@ada.edits');
const ig = link('instagram', 'https://instagram.com/ada.edits');
const yt = link('youtube', 'https://youtube.com/@adaedits');
const fb = link('facebook', 'https://facebook.com/ada');
const tw = link('twitch', 'https://twitch.tv/adaedits');
// Stored as the URL parser writes it, with the slash a bare address gets.
const site = link('website', 'https://adaedits.com/');
const tg = link('telegram', 'https://t.me/adaedits');

const errorCode = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code;
  }
};

async function setUp(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const signUp = async (phone, handle) => {
    await requestSignInCode(database.db, { phone, secret, now: new Date() });
    const code = /\b(\d{6})\b/.exec(
      (await listPretendOutbox(database.db, { limit: 1 }))[0].body,
    )[1];
    const { userId } = await verifySignInCode(database.db, {
      phone,
      code,
      secret,
    });
    await claimHandle(database.db, { userId, handle, now });
    await setPageState(database.db, userId, 'live');
    return userId;
  };
  const plan = (handle, value) =>
    database.pool.query(
      'UPDATE profiles SET plan = $2 WHERE handle_lower = $1',
      [handle, value],
    );
  return { database, signUp, plan };
}

test('a Free page saves up to 3 Free-site links in catalogue order, and shows them', async (t) => {
  const { database, signUp } = await setUp(t);
  const ada = await signUp('+2348031240001', 'ada_links');
  const mine = await setMyLinks(database.db, ada, {
    links: [tt, ig, yt],
    show: true,
  });
  assert.deepEqual(mine.links, [tt, ig, yt]);
  assert.equal(mine.socialsPublic, true);
  assert.deepEqual(mine.socials, { instagram: ig.url });
  assert.deepEqual((await publicProfile(database.db, 'ada_links')).links, [
    tt,
    ig,
    yt,
  ]);
  // Hidden from the page when the owner says so, and kept.
  await setMyLinks(database.db, ada, { links: [tt, ig, yt], show: false });
  assert.equal(
    'links' in (await publicProfile(database.db, 'ada_links')),
    false,
  );
  assert.deepEqual((await getMyProfile(database.db, ada)).links, [tt, ig, yt]);
});

/** The old column, as an API from before social links (or a rollback) reads it. */
const oldColumn = async (database, handle) =>
  (
    await database.pool.query(
      'SELECT socials FROM profiles WHERE handle_lower = $1',
      [handle],
    )
  ).rows[0].socials;

test('every save also writes the old three links, from what shows, so a rollback stays truthful', async (t) => {
  const { database, signUp, plan } = await setUp(t);
  const ada = await signUp('+2348031240011', 'ada_links');
  await setMyLinks(database.db, ada, { links: [tt, ig, yt], show: true });
  assert.deepEqual(await oldColumn(database, 'ada_links'), {
    instagram: ig.url,
  });
  await setMyLinks(database.db, ada, { links: [tt], show: true });
  assert.deepEqual(
    await oldColumn(database, 'ada_links'),
    {},
    'a removed link is gone from the old column too',
  );
  await plan('ada_links', 'pro');
  const x = link('x', 'https://x.com/ada');
  await setMyLinks(database.db, ada, {
    links: [tg, fb, x, ig],
    show: true,
  });
  assert.deepEqual(await oldColumn(database, 'ada_links'), {
    facebook: fb.url,
    x: x.url,
    instagram: ig.url,
  });
  // What a Free page would show is what the old column holds after a Free save.
  await plan('ada_links', 'free');
  await setMyLinks(database.db, ada, { links: [fb], show: true });
  const free = await oldColumn(database, 'ada_links');
  assert.deepEqual(
    free,
    legacyOf((await publicProfile(database.db, 'ada_links')).links),
  );
});

const legacyOf = (links) =>
  Object.fromEntries(
    links
      .filter((l) => ['facebook', 'instagram', 'x'].includes(l.platform))
      .map((l) => [l.platform, l.url]),
  );

test('a Free page can delete links kept from Pro, but never add or show them', async (t) => {
  const { database, signUp, plan } = await setUp(t);
  const ada = await signUp('+2348031240012', 'ada_links');
  await plan('ada_links', 'pro');
  const of = link('onlyfans', 'https://onlyfans.com/ada');
  await setMyLinks(database.db, ada, { links: [tw, tg, of, tt], show: true });
  await plan('ada_links', 'free');
  // Keep Telegram, delete OnlyFans.
  await setMyLinks(database.db, ada, {
    links: [tt, tw],
    show: true,
    hidden: [tg.url],
  });
  assert.deepEqual((await getMyProfile(database.db, ada)).links, [tt, tw, tg]);
  // Naming a link that isn't stored adds nothing.
  await setMyLinks(database.db, ada, {
    links: [tt, tw],
    show: true,
    hidden: [tg.url, 'https://t.me/someoneelse'],
  });
  assert.deepEqual((await getMyProfile(database.db, ada)).links, [tt, tw, tg]);
  // Pro sites never show on Free.
  assert.deepEqual((await publicProfile(database.db, 'ada_links')).links, [
    tt,
    tw,
  ]);
});

test('with adult-platform links switched off they leave the page and can’t be added, and are kept', async (t) => {
  const { database, signUp, plan } = await setUp(t);
  const ada = await signUp('+2348031240013', 'ada_links');
  await plan('ada_links', 'pro');
  const of = link('onlyfans', 'https://onlyfans.com/ada');
  await setMyLinks(database.db, ada, { links: [of, tt], show: true });
  const off = { adultLinks: false };
  assert.deepEqual((await publicProfile(database.db, 'ada_links', off)).links, [
    tt,
  ]);
  // Saving with the stored link still in the list works and keeps it.
  await setMyLinks(database.db, ada, { links: [of, tt, ig], show: true }, off);
  assert.deepEqual((await getMyProfile(database.db, ada)).links, [of, tt, ig]);
  assert.equal(
    await errorCode(
      setMyLinks(
        database.db,
        ada,
        {
          links: [of, tt, link('fansly', 'https://fansly.com/ada')],
          show: true,
        },
        off,
      ),
    ),
    'SOCIAL_LINK_UNAVAILABLE',
  );
  assert.deepEqual((await publicProfile(database.db, 'ada_links')).links, [
    of,
    tt,
    ig,
  ]);
});

test('a Free page cannot save what is part of Pro', async (t) => {
  const { database, signUp } = await setUp(t);
  const ada = await signUp('+2348031240002', 'ada_links');
  const refused = (links) =>
    errorCode(setMyLinks(database.db, ada, { links, show: true }));
  assert.equal(await refused([tt, fb, ig, yt]), 'SOCIAL_LINKS_PRO_REQUIRED');
  assert.equal(await refused([tg]), 'SOCIAL_LINKS_PRO_REQUIRED');
  assert.equal(await refused([site]), 'SOCIAL_LINKS_PRO_REQUIRED');
  assert.equal(
    await refused([link('onlyfans', 'https://onlyfans.com/ada')]),
    'SOCIAL_LINKS_PRO_REQUIRED',
  );
  assert.equal(
    await refused([{ ...tt, featured: true }]),
    'SOCIAL_LINKS_PRO_REQUIRED',
  );
  assert.equal(await refused([ig, tt]), 'SOCIAL_LINKS_PRO_REQUIRED');
  // A bad link is refused on every plan.
  assert.equal(
    await refused([link('instagram', 'https://evil.example/ada')]),
    'INVALID_INPUT',
  );
  assert.equal(
    await refused([link('website', 'https://linktr.ee/ada')]),
    'INVALID_INPUT',
  );
  assert.deepEqual((await getMyProfile(database.db, ada)).links, []);
});

test('a Pro page saves 8 in its own order with one featured; lapsing hides the extras and keeps them', async (t) => {
  const { database, signUp, plan } = await setUp(t);
  const ada = await signUp('+2348031240003', 'ada_links');
  await plan('ada_links', 'pro');
  const eight = [
    { ...tw, featured: true },
    tt,
    ig,
    yt,
    site,
    tg,
    fb,
    link('onlyfans', 'https://onlyfans.com/ada'),
  ];
  await setMyLinks(database.db, ada, { links: eight, show: true });
  assert.deepEqual(
    (await publicProfile(database.db, 'ada_links')).links,
    eight,
  );
  assert.equal(
    await errorCode(
      setMyLinks(database.db, ada, {
        links: [...eight, link('kick', 'https://kick.com/ada')],
        show: true,
      }),
    ),
    'INVALID_INPUT',
    'nine is more than Pro allows',
  );

  await plan('ada_links', 'free');
  assert.deepEqual((await publicProfile(database.db, 'ada_links')).links, [
    tw,
    tt,
    ig,
  ]);
  assert.deepEqual(
    (await getMyProfile(database.db, ada)).links,
    eight,
    'nothing is deleted',
  );

  // Editing on Free replaces what shows and keeps the hidden links behind it.
  await setMyLinks(database.db, ada, { links: [fb, tw], show: true });
  assert.deepEqual((await getMyProfile(database.db, ada)).links, [
    fb,
    tw,
    yt,
    site,
    tg,
    link('onlyfans', 'https://onlyfans.com/ada'),
  ]);
  assert.deepEqual((await publicProfile(database.db, 'ada_links')).links, [
    fb,
    tw,
    yt,
  ]);

  // Pro again: everything is back, in the saved order.
  await plan('ada_links', 'pro');
  assert.equal((await publicProfile(database.db, 'ada_links')).links.length, 6);
});

test('a Pro save waits for a plan change in progress, and is refused once the page is Free', async (t) => {
  const { database, signUp, plan } = await setUp(t);
  const ada = await signUp('+2348031240004', 'ada_links');
  await plan('ada_links', 'pro');
  const staff = await database.pool.connect();
  try {
    await staff.query('BEGIN');
    await staff.query(
      `SELECT id FROM profiles WHERE handle_lower = 'ada_links' FOR UPDATE`,
    );
    await staff.query(
      `UPDATE profiles SET plan = 'free' WHERE handle_lower = 'ada_links'`,
    );
    const save = errorCode(
      setMyLinks(database.db, ada, { links: [tg, tt], show: true }),
    );
    // The save is blocked on the row lock until the plan change commits.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await staff.query('COMMIT');
    assert.equal(await save, 'SOCIAL_LINKS_PRO_REQUIRED');
  } finally {
    staff.release();
  }
  assert.deepEqual((await getMyProfile(database.db, ada)).links, []);
});

test('the About form takes and ignores the old three links, so tabs opened before the release still save', async (t) => {
  const { database, signUp } = await setUp(t);
  const ada = await signUp('+2348031240005', 'ada_links');
  await setMyLinks(database.db, ada, { links: [tt], show: true });
  // What a Settings tab from before the release sends with every About save.
  const mine = await updateMyProfile(database.db, ada, {
    displayName: 'Ada Okafor',
    socials: { instagram: ig.url },
    socialsPublic: true,
  });
  assert.equal(mine.displayName, 'Ada Okafor');
  assert.deepEqual(mine.links, [tt], 'the old links are not applied');
});

test('the migration moves Facebook, Instagram and X into the new list, skipping bare sites and losing nothing', async (t) => {
  const { database, signUp } = await setUp(t);
  const handles = ['mig_a', 'mig_b', 'mig_c', 'mig_d'];
  const users = [];
  for (const [i, handle] of handles.entries())
    users.push(await signUp(`+234803124002${i}`, handle));
  const drizzle = new URL('../../drizzle/', import.meta.url);
  const file = readdirSync(drizzle).find((name) =>
    name.endsWith('_social_links.sql'),
  );
  const backfill = readFileSync(new URL(file, drizzle), 'utf8')
    .split('--> statement-breakpoint')
    .find((statement) => statement.includes('UPDATE "profiles"'));
  assert.ok(backfill, 'the migration has its backfill');
  const old = {
    // All three, in jsonb's own key order.
    mig_a: {
      x: 'https://twitter.com/ada',
      instagram: 'https://instagram.com/ada',
      facebook: 'https://www.facebook.com/ada',
    },
    // Nothing.
    mig_b: {},
    // Bare sites (the old rules allowed them) and an empty string are skipped.
    mig_c: {
      instagram: 'https://instagram.com/',
      facebook: 'https://facebook.com/?hl=en',
      x: '',
    },
    // A value that isn't a string is skipped; the good one still moves.
    mig_d: { facebook: 42, x: 'https://x.com/ada' },
  };
  for (const [handle, socials] of Object.entries(old))
    await database.pool.query(
      `UPDATE profiles SET links = '[]'::jsonb, socials = $2::jsonb WHERE handle_lower = $1`,
      [handle, JSON.stringify(socials)],
    );
  await database.pool.query(backfill);
  const after = async () =>
    Promise.all(
      users.map(async (user) => (await getMyProfile(database.db, user)).links),
    );
  const expected = [
    [
      link('facebook', 'https://www.facebook.com/ada'),
      link('instagram', 'https://instagram.com/ada'),
      link('x', 'https://twitter.com/ada'),
    ],
    [],
    [],
    [link('x', 'https://x.com/ada')],
  ];
  assert.deepEqual(await after(), expected);
  // Running it again changes nothing.
  await database.pool.query(backfill);
  assert.deepEqual(await after(), expected);
  // The old column is left as it was, bare sites included.
  assert.deepEqual(await oldColumn(database, 'mig_a'), old.mig_a);
  assert.deepEqual(await oldColumn(database, 'mig_c'), old.mig_c);
});
