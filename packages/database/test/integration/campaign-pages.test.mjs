import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  campaignDetail,
  createCampaign,
  publicCampaignPage,
  saveCampaignPage,
  stopCampaign,
} from '../../dist/index.js';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// Campaign pages (plan 2026-11-14 Task 4; board ProCampaignPages sections 2 and 3).
const NOW = new Date('2026-11-15T10:00:00Z');
const q = (db, text, values = []) =>
  db.pool.query(text, values).then((result) => result.rows);
const setPlan = (db, plan, id = ADA) =>
  db.pool.query(`UPDATE profiles SET plan = $2 WHERE id = $1`, [id, plan]);
const body = (over = {}) => ({
  on: true,
  headline: 'Thank you for dancing with me at Lagos Live',
  description: null,
  cover: null,
  ...over,
});

async function setup(t, plan = 'pro') {
  const db = await useDatabase(t);
  await db.fresh();
  await setPlan(db, plan);
  return db;
}

const make = (db, over = {}) =>
  createCampaign(db.db, ADA, {
    name: 'Lagos Live, Nov',
    slug: 'lagoslive',
    now: NOW,
    page: true,
    ...over,
  });

test('a Pro campaign starts with its own page and its name as headline', async (t) => {
  const db = await setup(t);
  const campaign = await make(db);
  const detail = await campaignDetail(db.db, ADA, campaign.id, NOW);
  assert.deepEqual(detail.page, {
    on: true,
    headline: 'Lagos Live, Nov',
    description: null,
    cover: null,
  });
});

test('a Free campaign starts with no page', async (t) => {
  const db = await setup(t, 'free');
  const campaign = await make(db);
  const [row] = await q(
    db,
    `SELECT page_on, headline FROM campaigns WHERE id = $1`,
    [campaign.id],
  );
  assert.deepEqual(row, { page_on: false, headline: null });
  // And while campaign pages are switched off, a Pro campaign starts with none either.
  await setPlan(db, 'pro');
  const off = await make(db, { slug: 'off', page: false });
  const [offRow] = await q(
    db,
    `SELECT page_on, headline FROM campaigns WHERE id = $1`,
    [off.id],
  );
  assert.deepEqual(offRow, { page_on: false, headline: null });
});

test('campaigns made before the release keep page_on false', async (t) => {
  const db = await setup(t);
  await db.pool.query(
    `INSERT INTO campaigns (id, profile_id, name, slug) VALUES (gen_random_uuid(), $1, 'Old', 'old')`,
    [ADA],
  );
  const [row] = await q(
    db,
    `SELECT page_on, headline, description, cover_design, cover_colour, cover_animation, cover_motion FROM campaigns WHERE slug = 'old'`,
  );
  assert.deepEqual(row, {
    page_on: false,
    headline: null,
    description: null,
    cover_design: null,
    cover_colour: null,
    cover_animation: null,
    cover_motion: null,
  });
  assert.equal(await publicCampaignPage(db.db, 'ada', 'old'), null);
});

test('saving on Free is refused and nothing changes', async (t) => {
  const db = await setup(t);
  const campaign = await make(db);
  await setPlan(db, 'free');
  await assert.rejects(
    saveCampaignPage(db.db, ADA, campaign.id, body({ headline: 'New' })),
    { code: 'CAMPAIGN_PRO_REQUIRED' },
  );
  const [row] = await q(db, `SELECT headline FROM campaigns WHERE id = $1`, [
    campaign.id,
  ]);
  assert.equal(row.headline, 'Lagos Live, Nov');
});

test('a lapse during save leaves the row as it was', async (t) => {
  const db = await setup(t);
  const campaign = await make(db);
  // Another transaction holds the page and lapses it; the save waits on the lock, then sees Free.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT 1 FROM profiles WHERE id = $1 FOR UPDATE`, [
      ADA,
    ]);
    const saving = saveCampaignPage(
      db.db,
      ADA,
      campaign.id,
      body({ headline: 'Changed during the lapse' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await client.query(`UPDATE profiles SET plan = 'free' WHERE id = $1`, [
      ADA,
    ]);
    await client.query('COMMIT');
    await assert.rejects(saving, { code: 'CAMPAIGN_PRO_REQUIRED' });
  } finally {
    client.release();
  }
  const [row] = await q(db, `SELECT headline FROM campaigns WHERE id = $1`, [
    campaign.id,
  ]);
  assert.equal(row.headline, 'Lagos Live, Nov');
});

test('a stopped campaign or someone else’s is refused', async (t) => {
  const db = await setup(t);
  const campaign = await make(db);
  await assert.rejects(saveCampaignPage(db.db, TOBI, campaign.id, body()), {
    code: 'CAMPAIGN_NOT_FOUND',
  });
  await assert.rejects(saveCampaignPage(db.db, ADA, 'not-a-uuid', body()), {
    code: 'CAMPAIGN_NOT_FOUND',
  });
  await stopCampaign(db.db, ADA, campaign.id, NOW);
  await assert.rejects(saveCampaignPage(db.db, ADA, campaign.id, body()), {
    code: 'CAMPAIGN_STOPPED',
  });
});

test('another page’s handle or display name as headline is refused', async (t) => {
  const db = await setup(t);
  const campaign = await make(db);
  for (const headline of [
    'Thanks from @tobi',
    'Thanks from @TOBI!',
    'Tobi Adeyemi',
    'tobi  adeyemi',
  ])
    await assert.rejects(
      saveCampaignPage(
        db.db,
        ADA,
        campaign.id,
        body({ headline: headline.replace(/\s+/g, ' ') }),
      ),
      { code: 'CAMPAIGN_HEADLINE_NAME' },
      headline,
    );
  // An old handle of another page counts as theirs.
  await db.pool.query(
    `INSERT INTO handle_aliases (handle_lower, profile_id) VALUES ('oldtobi', $1)`,
    [TOBI],
  );
  await assert.rejects(
    saveCampaignPage(
      db.db,
      ADA,
      campaign.id,
      body({ headline: 'Hi @oldtobi' }),
    ),
    { code: 'CAMPAIGN_HEADLINE_NAME' },
  );
});

test('own handle is fine', async (t) => {
  const db = await setup(t);
  const campaign = await make(db);
  const saved = await saveCampaignPage(
    db.db,
    ADA,
    campaign.id,
    body({ headline: 'Thanks from @ada', description: 'Ada Okafor, live' }),
  );
  assert.equal(saved.headline, 'Thanks from @ada');
  const own = await saveCampaignPage(
    db.db,
    ADA,
    campaign.id,
    body({ headline: 'Ada Okafor' }),
  );
  assert.equal(own.headline, 'Ada Okafor');
});

test('publicCampaignPage is null for: stopped, page off, free page, unknown slug, not-live page', async (t) => {
  const db = await setup(t);
  const campaign = await make(db);
  assert.ok(await publicCampaignPage(db.db, 'ada', 'lagoslive'));
  assert.equal(await publicCampaignPage(db.db, 'ada', 'nope'), null);
  assert.equal(await publicCampaignPage(db.db, 'ada', 'Bad Slug'), null);
  assert.equal(await publicCampaignPage(db.db, 'tobi', 'lagoslive'), null);

  await setPlan(db, 'free');
  assert.equal(await publicCampaignPage(db.db, 'ada', 'lagoslive'), null);
  await setPlan(db, 'pro');

  await db.pool.query(
    `UPDATE profiles SET page_state = 'not_live' WHERE id = $1`,
    [ADA],
  );
  assert.equal(await publicCampaignPage(db.db, 'ada', 'lagoslive'), null);
  await db.pool.query(
    `UPDATE profiles SET page_state = 'live', status = 'active' WHERE id = $1`,
    [ADA],
  );

  await saveCampaignPage(db.db, ADA, campaign.id, body({ on: false }));
  assert.equal(await publicCampaignPage(db.db, 'ada', 'lagoslive'), null);
  await saveCampaignPage(db.db, ADA, campaign.id, body());
  assert.ok(await publicCampaignPage(db.db, 'ada', 'lagoslive'));

  await stopCampaign(db.db, ADA, campaign.id, NOW);
  assert.equal(await publicCampaignPage(db.db, 'ada', 'lagoslive'), null);
});

test('returns headline, description and the resolved cover', async (t) => {
  const db = await setup(t);
  const campaign = await make(db);
  assert.deepEqual(await publicCampaignPage(db.db, 'ADA', 'lagoslive'), {
    slug: 'lagoslive',
    headline: 'Lagos Live, Nov',
  });
  const saved = await saveCampaignPage(
    db.db,
    ADA,
    campaign.id,
    body({
      description: 'Saturday 15 Nov at Muri Okunola Park.',
      cover: { design: 'scattered', colour: null },
    }),
  );
  assert.deepEqual(saved.cover, { design: 'scattered', colour: null });
  const page = await publicCampaignPage(db.db, 'ada', 'lagoslive');
  assert.equal(page.headline, 'Thank you for dancing with me at Lagos Live');
  assert.equal(page.description, 'Saturday 15 Nov at Muri Okunola Park.');
  assert.equal(page.cover.kind, 'design');
  assert.equal(page.cover.design, 'scattered');
  // Never the campaign's id, name or results.
  assert.deepEqual(Object.keys(page).sort(), [
    'cover',
    'description',
    'headline',
    'slug',
  ]);
  // An animated cover plays as the page's plan allows.
  await saveCampaignPage(
    db.db,
    ADA,
    campaign.id,
    body({ cover: { design: null, animation: 'pulse', motion: 'loop' } }),
  );
  const animated = await publicCampaignPage(db.db, 'ada', 'lagoslive');
  assert.deepEqual(animated.cover, {
    kind: 'animated',
    animation: 'pulse',
    play: 'loop',
  });
  const detail = await campaignDetail(db.db, ADA, campaign.id, NOW);
  assert.deepEqual(detail.page.cover, {
    design: null,
    animation: 'pulse',
    motion: 'loop',
  });
});
