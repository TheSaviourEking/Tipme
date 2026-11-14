import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  notePlanChange,
  proSpans,
  setStaffPro,
  wasProAt,
} from '../../dist/index.js';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// Plan history (plan 2026-11-14 Task 2): which days a page was Pro, for statements and goals.
const q = (db, text, values = []) =>
  db.pool.query(text, values).then((result) => result.rows);
const changes = (db, id = ADA) =>
  q(
    db,
    `SELECT plan, changed_at FROM plan_changes WHERE profile_id = $1 ORDER BY changed_at`,
    [id],
  );
/** Lagos midnight at the start of that day (UTC+1, no daylight saving). */
const lagosDay = (date) => new Date(`${date}T00:00:00+01:00`);
const iso = (spans) =>
  spans.map((s) => ({ from: s.from.toISOString(), to: s.to.toISOString() }));

test('recomputePlan writes one row per change and none when unchanged', async (t) => {
  const db = await useDatabase(t);
  await db.fresh();
  const staff = (on, now) =>
    db.db.transaction((tx) => setStaffPro(tx, ADA, on, now));
  await staff(true, new Date('2026-11-01T10:00:00Z'));
  assert.deepEqual(
    (await changes(db)).map((r) => r.plan),
    ['pro'],
  );
  await staff(true, new Date('2026-11-02T10:00:00Z'));
  assert.equal((await changes(db)).length, 1);
  await staff(false, new Date('2026-11-03T10:00:00Z'));
  const rows = await changes(db);
  assert.deepEqual(
    rows.map((r) => [r.plan, r.changed_at.toISOString()]),
    [
      ['pro', '2026-11-01T10:00:00.000Z'],
      ['free', '2026-11-03T10:00:00.000Z'],
    ],
  );
});

test('proSpans clips to the window', async (t) => {
  const db = await useDatabase(t);
  await db.fresh();
  await db.db.transaction(async (tx) => {
    await notePlanChange(tx, ADA, 'pro', new Date('2026-08-10T09:00:00Z'));
    await notePlanChange(tx, ADA, 'free', new Date('2026-12-14T00:00:00Z'));
  });
  assert.deepEqual(
    iso(
      await proSpans(
        db.db,
        ADA,
        lagosDay('2026-08-01'),
        lagosDay('2026-09-01'),
      ),
    ),
    [
      {
        from: '2026-08-10T09:00:00.000Z',
        to: lagosDay('2026-09-01').toISOString(),
      },
    ],
  );
  assert.deepEqual(
    iso(
      await proSpans(
        db.db,
        ADA,
        lagosDay('2026-12-01'),
        lagosDay('2027-01-01'),
      ),
    ),
    [
      {
        from: lagosDay('2026-12-01').toISOString(),
        to: '2026-12-14T00:00:00.000Z',
      },
    ],
  );
  assert.deepEqual(
    iso(
      await proSpans(
        db.db,
        ADA,
        lagosDay('2026-10-01'),
        lagosDay('2026-11-01'),
      ),
    ),
    [
      {
        from: lagosDay('2026-10-01').toISOString(),
        to: lagosDay('2026-11-01').toISOString(),
      },
    ],
  );
  // Before the first change, and a gap inside: free days are not in any span.
  await db.db.transaction(async (tx) => {
    await notePlanChange(tx, ADA, 'pro', new Date('2026-12-20T00:00:00Z'));
  });
  const july = await proSpans(
    db.db,
    ADA,
    lagosDay('2026-07-01'),
    lagosDay('2026-08-01'),
  );
  assert.deepEqual(july, []);
  const december = await proSpans(
    db.db,
    ADA,
    lagosDay('2026-12-01'),
    lagosDay('2027-01-01'),
  );
  assert.deepEqual(iso(december), [
    {
      from: lagosDay('2026-12-01').toISOString(),
      to: '2026-12-14T00:00:00.000Z',
    },
    {
      from: '2026-12-20T00:00:00.000Z',
      to: lagosDay('2027-01-01').toISOString(),
    },
  ]);
  assert.equal(wasProAt(december, new Date('2026-12-13T23:59:59.999Z')), true);
  assert.equal(wasProAt(december, new Date('2026-12-14T00:00:00Z')), false);
  assert.equal(wasProAt(december, new Date('2026-12-20T00:00:00Z')), true);
});

test('no history uses the current plan', async (t) => {
  const db = await useDatabase(t);
  await db.fresh();
  await db.pool.query(`DELETE FROM plan_changes`);
  await db.pool.query(`UPDATE profiles SET plan = 'pro' WHERE id = $1`, [ADA]);
  const from = lagosDay('2026-10-01');
  const to = lagosDay('2026-11-01');
  assert.deepEqual(iso(await proSpans(db.db, ADA, from, to)), [
    { from: from.toISOString(), to: to.toISOString() },
  ]);
  assert.deepEqual(await proSpans(db.db, TOBI, from, to), []);
});

test('the migration backfills Pro pages, once', async (t) => {
  const db = await useDatabase(t);
  await db.fresh();
  const dir = new URL('../../drizzle/', import.meta.url);
  // Merge train 2: the table (generated) and its backfill (generate --custom) are two migrations.
  const files = readdirSync(dir).filter((name) =>
    /^\d{4}_plan_changes(_backfill)?\.sql$/.test(name),
  );
  assert.equal(
    files.length,
    2,
    'the plan_changes migration and its backfill exist',
  );
  const backfill = files
    .map((file) => readFileSync(new URL(file, dir), 'utf8'))
    .join('--> statement-breakpoint')
    .split('--> statement-breakpoint')
    .map((part) => part.replace(/^(\s*--[^\n]*\n)+/, '').trim())
    .find((part) => /^INSERT INTO "?plan_changes"?/i.test(part));
  assert.ok(backfill, 'the migration has a backfill');
  // Ada is Pro (made so by SQL, as before the release) with a paid month; Tobi is Pro with none.
  await db.pool.query(`DELETE FROM plan_changes`);
  await db.pool.query(`UPDATE profiles SET plan = 'pro' WHERE id = ANY($1)`, [
    [ADA, TOBI],
  ]);
  await db.pool.query(
    `INSERT INTO pro_periods (id, profile_id, purchase_id, paid_by, amount_minor, currency, starts_at, ends_at, grace_ends_at, status)
     VALUES (gen_random_uuid(), $1, NULL, 'card', 250000, 'NGN', '2026-08-12T08:00:00Z', '2026-09-12T08:00:00Z', '2026-09-15T08:00:00Z', 'ENDED')`,
    [ADA],
  );
  await db.pool.query(backfill);
  await db.pool.query(backfill);
  const ada = await changes(db, ADA);
  assert.deepEqual(
    ada.map((r) => [r.plan, r.changed_at.toISOString()]),
    [['pro', '2026-08-12T08:00:00.000Z']],
  );
  const tobi = await changes(db, TOBI);
  assert.equal(tobi.length, 1);
  assert.equal(tobi[0].plan, 'pro');
  // The first instant of the Lagos month the migration ran in.
  const [{ month }] = await q(
    db,
    `SELECT date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos' AS month`,
  );
  assert.equal(tobi[0].changed_at.toISOString(), month.toISOString());
});
