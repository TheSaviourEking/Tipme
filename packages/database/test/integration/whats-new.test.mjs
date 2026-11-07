import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  deleteAccount,
  earlyAccessOf,
  listWhatsNew,
  markWhatsNewSeen,
  whatsNewStatus,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Changelog plan (5 Nov 2026), Task 6.1: what each person reads in What's new, and when they last
// looked. PRs 2–4 (ingest, admin) are built beside this one, so entries are seeded with SQL.
const ADA = DEMO_PROFILES[0];
const TOBI = DEMO_PROFILES[1];
const STAFF = ADA.userId;
const NOW = new Date('2026-11-06T12:00:00Z');

/** One entry, published and live unless told otherwise. */
async function seed(database, number, values = {}) {
  const text = values.text ?? `Update ${number}.`;
  const audience = values.audience ?? 'everyone';
  const published = values.published ?? true;
  const row = {
    pr_number: number,
    merge_sha: String(number).padStart(40, '0'),
    merged_at: '2026-11-01T10:00:00Z',
    pr_title: `feat: ${number}`,
    staff_text: `feat: ${number} — staff text ${number}.`,
    user_text: audience === 'staff' ? null : (values.working ?? text),
    audience,
    revision: values.revision ?? 1,
    published_text: published && audience !== 'staff' ? text : null,
    published_audience: published ? audience : null,
    published_revision: published ? (values.publishedRevision ?? 1) : null,
    approved_at: published ? '2026-11-02T10:00:00Z' : null,
    approved_by: published ? STAFF : null,
    live_at:
      values.liveAt === undefined ? '2026-11-05T10:00:00Z' : values.liveAt,
    live_version: values.liveAt === null ? null : 'abcdef012345',
    withdrawn_at: values.withdrawn ? '2026-11-06T09:00:00Z' : null,
    withdrawn_by: values.withdrawn ? STAFF : null,
    withdrawn_reason: values.withdrawn ? 'Rolled back' : null,
  };
  const columns = Object.keys(row);
  await database.pool.query(
    `INSERT INTO changelog_entries (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
}

/** The demo pages were made "now"; the marker's default starts there, so date them earlier. */
async function joined(database, iso = '2026-10-01T00:00:00Z') {
  await database.pool.query('UPDATE profiles SET created_at = $1', [iso]);
}

const numbers = (list) => list.entries.map((entry) => entry.number);

test('only approved, live, not withdrawn, user-facing entries are listed, newest first, with their Lagos live date', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await joined(database);
  await seed(database, 201, { liveAt: '2026-11-03T08:00:00Z' });
  // 23:30 UTC on 5 Nov is 00:30 on 6 Nov in Lagos.
  await seed(database, 202, { liveAt: '2026-11-05T23:30:00Z' });
  await seed(database, 203, { published: false }); // a draft
  await seed(database, 204, { liveAt: null }); // approved, not in production yet
  await seed(database, 205, { withdrawn: true });
  await seed(database, 206, { audience: 'staff' }); // recorded
  await seed(database, 207, { audience: 'staff', published: false }); // recorded, never approved
  const list = await listWhatsNew(database.db, ADA.userId);
  assert.deepEqual(list.entries, [
    {
      number: 202,
      line: 'Update 202.',
      pro: false,
      liveOn: '2026-11-06',
      liveAt: '2026-11-05T23:30:00.000Z',
    },
    {
      number: 201,
      line: 'Update 201.',
      pro: false,
      liveOn: '2026-11-03',
      liveAt: '2026-11-03T08:00:00.000Z',
    },
  ]);
  assert.equal(list.unseen, 2);
  // Nothing about the PR or staff work reaches users.
  assert.doesNotMatch(JSON.stringify(list), /staff text|feat: /);
});

test('a Free page sees Pro entries as "On Pro, …"; nobody sees early-access entries until early access exists', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await joined(database);
  await database.pool.query("UPDATE profiles SET plan = 'pro' WHERE id = $1", [
    TOBI.id,
  ]);
  await seed(database, 211, {
    audience: 'pro',
    text: 'You can pick a starting amount.',
  });
  await seed(database, 212, {
    audience: 'early_access',
    text: 'Try the new cover editor.',
  });
  for (const who of [ADA, TOBI]) {
    const list = await listWhatsNew(database.db, who.userId);
    assert.deepEqual(
      list.entries.map(({ number, line, pro }) => ({ number, line, pro })),
      [
        {
          number: 211,
          line: 'On Pro, you can pick a starting amount.',
          pro: true,
        },
      ],
      who.handle,
    );
  }
  const column = await database.pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'profiles' AND column_name = 'early_access'`,
  );
  if (column.rowCount === 0) return; // early access isn't built yet: nobody sees those entries
  // Once feat/early-access merges: a Pro page with it on sees them, a Free page never does.
  await database.pool.query('UPDATE profiles SET early_access = true');
  assert.deepEqual(
    numbers(await listWhatsNew(database.db, TOBI.userId)),
    [212, 211],
  );
  assert.deepEqual(numbers(await listWhatsNew(database.db, ADA.userId)), [211]);
});

test('earlyAccessOf is false without the early-access column and follows it when present', () => {
  assert.equal(earlyAccessOf({ plan: 'pro' }), false);
  assert.equal(earlyAccessOf({ plan: 'pro', earlyAccess: null }), false);
  assert.equal(earlyAccessOf({ plan: 'pro', earlyAccess: false }), false);
  assert.equal(earlyAccessOf({ plan: 'pro', earlyAccess: true }), true);
});

test('an edit after approval shows the approved text, not the edit', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await joined(database);
  await seed(database, 221, {
    text: 'Pin a supporter note to your page.',
    working: 'Pin up to three supporter notes.',
    revision: 2,
    publishedRevision: 1,
  });
  // An approved entry whose user text was then removed (not yet approved): users still read it.
  await database.pool.query(
    `INSERT INTO changelog_entries (pr_number, merge_sha, merged_at, pr_title, staff_text, user_text,
       audience, revision, published_text, published_audience, published_revision, live_at)
     VALUES (222, $1, now(), 't', 's', NULL, 'staff', 2, 'Faster receipts.', 'everyone', 1, '2026-11-04T10:00:00Z')`,
    ['2'.repeat(40)],
  );
  const list = await listWhatsNew(database.db, ADA.userId);
  assert.deepEqual(
    list.entries.map((entry) => entry.line),
    ['Pin a supporter note to your page.', 'Faster receipts.'],
  );
});

test('unseen counts entries live after the marker; a new person starts at their profile creation', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await database.pool.query(
    'UPDATE profiles SET created_at = $1 WHERE id = $2',
    ['2026-10-01T00:00:00Z', ADA.id],
  );
  // Tobi joined on 4 Nov: the update of 3 Nov is listed but never counted as new for them.
  await database.pool.query(
    'UPDATE profiles SET created_at = $1 WHERE id = $2',
    ['2026-11-04T00:00:00Z', TOBI.id],
  );
  await seed(database, 231, { liveAt: '2026-11-03T10:00:00Z' });
  await seed(database, 232, {
    liveAt: '2026-11-05T10:00:00Z',
    text: 'Newest.',
  });
  const ada = await whatsNewStatus(database.db, ADA.userId);
  assert.equal(ada.unseen, 2);
  assert.equal(ada.newest?.number, 232);
  assert.equal(ada.newest?.line, 'Newest.');
  const tobi = await whatsNewStatus(database.db, TOBI.userId);
  assert.equal(tobi.unseen, 1);
  assert.equal(
    (await listWhatsNew(database.db, TOBI.userId)).entries.length,
    2,
  );

  await markWhatsNewSeen(database.db, {
    userId: ADA.userId,
    through: new Date('2026-11-03T10:00:00Z'),
    now: NOW,
  });
  assert.equal((await whatsNewStatus(database.db, ADA.userId)).unseen, 1);
  await markWhatsNewSeen(database.db, {
    userId: ADA.userId,
    through: new Date('2026-11-05T10:00:00Z'),
    now: NOW,
  });
  const after = await whatsNewStatus(database.db, ADA.userId);
  assert.equal(after.unseen, 0);
  // The newest stays readable for the page; only the count drops.
  assert.equal(after.newest?.number, 232);
  // Nothing at all: no count, no newest.
  await database.pool.query('DELETE FROM changelog_entries');
  assert.deepEqual(await whatsNewStatus(database.db, ADA.userId), {
    unseen: 0,
    newest: null,
  });
});

test('the marker never moves back and never past now', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await joined(database);
  const marker = async () =>
    (
      await database.pool.query(
        'SELECT seen_through FROM changelog_reads WHERE user_id = $1',
        [ADA.userId],
      )
    ).rows[0]?.seen_through.toISOString();
  await markWhatsNewSeen(database.db, {
    userId: ADA.userId,
    through: new Date('2026-11-05T10:00:00Z'),
    now: NOW,
  });
  assert.equal(await marker(), '2026-11-05T10:00:00.000Z');
  // A stale tab sends an older instant: the marker stays.
  await markWhatsNewSeen(database.db, {
    userId: ADA.userId,
    through: new Date('2026-11-01T10:00:00Z'),
    now: NOW,
  });
  assert.equal(await marker(), '2026-11-05T10:00:00.000Z');
  // A clock in the future can't hide updates that haven't gone live yet.
  await markWhatsNewSeen(database.db, {
    userId: ADA.userId,
    through: new Date('2027-01-01T00:00:00Z'),
    now: NOW,
  });
  assert.equal(await marker(), NOW.toISOString());
  // One row per person.
  assert.equal(await database.count('changelog_reads'), 1);
});

test('deleting the account removes the marker', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await joined(database);
  for (const who of [ADA, TOBI])
    await markWhatsNewSeen(database.db, {
      userId: who.userId,
      through: new Date('2026-11-05T10:00:00Z'),
      now: NOW,
    });
  await deleteAccount(database.db, { userId: TOBI.userId, now: NOW });
  const { rows } = await database.pool.query(
    'SELECT user_id FROM changelog_reads ORDER BY user_id',
  );
  assert.deepEqual(
    rows.map((row) => row.user_id),
    [ADA.userId],
  );
});

test('a person without a page is refused', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await database.pool.query(
    "UPDATE profiles SET page_state = 'deleted' WHERE id = $1",
    [ADA.id],
  );
  await assert.rejects(listWhatsNew(database.db, ADA.userId), {
    code: 'NO_PAGE',
  });
  await assert.rejects(whatsNewStatus(database.db, ADA.userId), {
    code: 'NO_PAGE',
  });
});
