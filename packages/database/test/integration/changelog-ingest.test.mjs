import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changelogState } from '@tipme/contracts';
import {
  markReleased,
  pendingForRelease,
  recordChangelogDraft,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Changelog plan (5 Nov 2026), Task 2.1: drafts from merged PRs, and what each environment runs.
const sha = (n) => n.toString(16).padStart(40, 'a');
const VERSION = '0123456789ab';

const pr = (number, values = {}) => ({
  number,
  title: `feat: change ${number}`,
  body: `Does thing ${number}.\n\n## For users\nYou can now do thing ${number}.\n`,
  mergeCommitSha: sha(number),
  mergedAt: `2026-11-0${(number % 5) + 1}T10:00:00Z`,
  ...values,
});

async function entry(database, number) {
  const { rows } = await database.pool.query(
    `SELECT pr_number, merge_sha, merged_at, pr_title, staff_text, user_text, audience,
            revision, published_revision, staging_at, live_at, live_version, withdrawn_at
       FROM changelog_entries WHERE pr_number = $1`,
    [number],
  );
  return rows[0];
}

/** Withdrawn by the first seeded user (the column refers to users). */
async function withdraw(database, number) {
  await database.pool.query(
    `UPDATE changelog_entries SET withdrawn_at = now(),
            withdrawn_by = (SELECT id FROM users ORDER BY id LIMIT 1),
            withdrawn_reason = 'not shipping' WHERE pr_number = $1`,
    [number],
  );
}

async function audits(database, action) {
  const { rows } = await database.pool.query(
    `SELECT staff_user_id, action, subject_type, subject_id, reason
       FROM audit_events WHERE action = $1 ORDER BY seq`,
    [action],
  );
  return rows;
}

test('a draft is created once; sending it again changes nothing, even after staff edits', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  assert.deepEqual(await recordChangelogDraft(database.db, pr(140)), {
    created: true,
  });
  const first = await entry(database, 140);
  assert.equal(first.merge_sha, sha(140));
  assert.equal(first.pr_title, 'feat: change 140');
  assert.equal(first.staff_text, 'feat: change 140 — Does thing 140.');
  assert.equal(first.user_text, 'You can now do thing 140.');
  assert.equal(first.audience, 'everyone');
  assert.equal(first.revision, 1);
  assert.equal(first.merged_at.toISOString(), '2026-11-01T10:00:00.000Z');

  // Staff edit the working copy, then CI sends the same PR again (a re-run or a resend).
  await database.pool.query(
    `UPDATE changelog_entries SET user_text = 'Edited by staff.', revision = 2
      WHERE pr_number = 140`,
  );
  assert.deepEqual(
    await recordChangelogDraft(
      database.db,
      pr(140, { title: 'feat: renamed', body: 'Other.' }),
    ),
    { created: false },
  );
  const again = await entry(database, 140);
  assert.equal(again.user_text, 'Edited by staff.');
  assert.equal(again.revision, 2);
  assert.equal(again.pr_title, 'feat: change 140');
  assert.deepEqual(await audits(database, 'changelog.drafted'), [
    {
      staff_user_id: null,
      action: 'changelog.drafted',
      subject_type: 'changelog_entry',
      subject_id: '140',
      reason: '#140, revision 1',
    },
  ]);
});

test('a draft without a For users section is staff only and recorded', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  for (const body of [
    null,
    'Why.\n\n## For users\n<!-- hint -->\n\n## Evidence',
  ])
    await recordChangelogDraft(
      database.db,
      pr(body ? 151 : 150, { title: 'fix(ci): x', body }),
    );
  for (const number of [150, 151]) {
    const row = await entry(database, number);
    assert.equal(row.user_text, null);
    assert.equal(row.audience, 'staff');
    assert.equal(
      changelogState({
        audience: row.audience,
        publishedRevision: row.published_revision,
        liveAt: null,
        withdrawnAt: null,
      }),
      'recorded',
    );
  }
  assert.equal((await entry(database, 150)).staff_text, 'fix(ci): x');
  assert.equal((await entry(database, 151)).staff_text, 'fix(ci): x — Why.');
});

test('the PR body is not stored anywhere', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const MARKER = 'body-marker-7f3c9e1d';
  await recordChangelogDraft(
    database.db,
    pr(160, {
      body: `First paragraph.\n\n## Scope\nSecret detail ${MARKER}.\n\n## For users\nYou can pin a note.\n\n## Evidence\n${MARKER} again`,
    }),
  );
  const { rows } = await database.pool.query(
    `SELECT count(*)::int AS n FROM (
       SELECT row_to_json(c)::text AS t FROM changelog_entries c
       UNION ALL SELECT row_to_json(a)::text FROM audit_events a
     ) everything WHERE t LIKE $1`,
    [`%${MARKER}%`],
  );
  assert.equal(rows[0].n, 0);
  const row = await entry(database, 160);
  assert.equal(row.staff_text, 'feat: change 160 — First paragraph.');
  assert.equal(row.user_text, 'You can pin a note.');
});

test('pending lists entries not yet live and not withdrawn, oldest first', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await recordChangelogDraft(
    database.db,
    pr(172, { mergedAt: '2026-11-03T10:00:00Z' }),
  );
  await recordChangelogDraft(
    database.db,
    pr(170, { mergedAt: '2026-11-04T10:00:00Z' }),
  );
  await recordChangelogDraft(
    database.db,
    pr(171, { mergedAt: '2026-11-02T10:00:00Z' }),
  );
  await recordChangelogDraft(
    database.db,
    pr(173, { mergedAt: '2026-11-01T10:00:00Z' }),
  );
  await database.pool.query(
    `UPDATE changelog_entries SET live_at = now(), live_version = $1 WHERE pr_number = 172`,
    [VERSION],
  );
  await withdraw(database, 173);
  assert.deepEqual(await pendingForRelease(database.db, 'production'), [
    { number: 171, mergeSha: sha(171) },
    { number: 170, mergeSha: sha(170) },
  ]);
  // Staging asks about its own column: 172 is live in production but was never seen on staging.
  assert.deepEqual(await pendingForRelease(database.db, 'staging'), [
    { number: 171, mergeSha: sha(171) },
    { number: 172, mergeSha: sha(172) },
    { number: 170, mergeSha: sha(170) },
  ]);
});

test('markReleased sets live_at and live_version once; a second call keeps the first date', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await recordChangelogDraft(database.db, pr(180));
  await recordChangelogDraft(database.db, pr(181));
  const first = new Date('2026-11-06T09:00:00Z');
  assert.deepEqual(
    await markReleased(database.db, {
      environment: 'production',
      version: VERSION,
      contained: [180],
      now: first,
    }),
    { marked: [180] },
  );
  assert.deepEqual(
    await markReleased(database.db, {
      environment: 'production',
      version: 'ba9876543210',
      contained: [180, 181],
      now: new Date('2026-11-07T09:00:00Z'),
    }),
    { marked: [181] },
  );
  const a = await entry(database, 180);
  assert.equal(a.live_at.toISOString(), first.toISOString());
  assert.equal(a.live_version, VERSION);
  assert.equal(a.staging_at, null);
  const b = await entry(database, 181);
  assert.equal(b.live_version, 'ba9876543210');
  assert.deepEqual(await pendingForRelease(database.db, 'production'), []);
});

test('staging marking sets staging_at only, never live_at', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await recordChangelogDraft(database.db, pr(190));
  const now = new Date('2026-11-06T09:00:00Z');
  assert.deepEqual(
    await markReleased(database.db, {
      environment: 'staging',
      version: VERSION,
      contained: [190],
      now,
    }),
    { marked: [190] },
  );
  const row = await entry(database, 190);
  assert.equal(row.staging_at.toISOString(), now.toISOString());
  assert.equal(row.live_at, null);
  assert.equal(row.live_version, null);
  assert.deepEqual(await pendingForRelease(database.db, 'staging'), []);
  assert.deepEqual(await pendingForRelease(database.db, 'production'), [
    { number: 190, mergeSha: sha(190) },
  ]);
});

test('markReleased ignores unknown numbers and withdrawn entries, and writes one changelog.released audit entry', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  await recordChangelogDraft(database.db, pr(200));
  await recordChangelogDraft(database.db, pr(201));
  await recordChangelogDraft(database.db, pr(202));
  await withdraw(database, 201);
  assert.deepEqual(
    await markReleased(database.db, {
      environment: 'production',
      version: VERSION,
      contained: [202, 201, 999, 200],
    }),
    { marked: [200, 202] },
  );
  assert.equal((await entry(database, 201)).live_at, null);
  assert.equal(await database.count('changelog_entries'), 3);
  // A replay marks nothing and adds no audit entry.
  assert.deepEqual(
    await markReleased(database.db, {
      environment: 'production',
      version: VERSION,
      contained: [200, 202],
    }),
    { marked: [] },
  );
  assert.deepEqual(await audits(database, 'changelog.released'), [
    {
      staff_user_id: null,
      action: 'changelog.released',
      subject_type: 'changelog_release',
      subject_id: `production:${VERSION}`,
      reason: `production ${VERSION}: #200, #202`,
    },
  ]);
});
