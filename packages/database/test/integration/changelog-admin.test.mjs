import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  approveChangelogEntry,
  editChangelogEntry,
  listChangelog,
  readChangelogEntry,
  withdrawChangelogEntry,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Changelog plan (5 Nov 2026), Task 4.1: what staff do to an entry, and what users can then read.
const SHA = 'b'.repeat(40);
const REASON = 'Checked the wording with the team today';

async function staffUser(
  database,
  email = `staff.${randomUUID()}@example.com`,
) {
  const { rows } = await database.pool.query(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [email],
  );
  return rows[0].id;
}

async function entry(database, values = {}) {
  const row = {
    pr_number: 200,
    merge_sha: SHA,
    merged_at: '2026-11-06T10:00:00Z',
    pr_title: 'feat: pins',
    staff_text: 'feat: pins — Adds pins.',
    user_text: 'You can pin a supporter note.',
    audience: 'everyone',
    ...values,
  };
  const columns = Object.keys(row);
  await database.pool.query(
    `INSERT INTO changelog_entries (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
  return row.pr_number;
}

const rowOf = async (database, number) =>
  (
    await database.pool.query(
      `SELECT * FROM changelog_entries WHERE pr_number = $1`,
      [number],
    )
  ).rows[0];

const auditOf = async (database, action) =>
  (
    await database.pool.query(
      `SELECT * FROM audit_events WHERE action = $1 ORDER BY created_at`,
      [action],
    )
  ).rows;

const numbers = (page) => page.rows.map((row) => row.number);

/** What users can read: the What's new conditions from Design §6, without the per-person filter. */
const userVisible = async (database) =>
  (
    await database.pool.query(
      `SELECT pr_number FROM changelog_entries
        WHERE withdrawn_at IS NULL AND published_revision IS NOT NULL
          AND published_audience <> 'staff' ORDER BY pr_number`,
    )
  ).rows.map((row) => row.pr_number);

test('the views: drafts holds unapproved and edited-after-approval entries; users holds published ones; staff holds recorded', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const publisher = await staffUser(database);
  await entry(database, { pr_number: 201, merged_at: '2026-11-01T10:00:00Z' });
  await entry(database, { pr_number: 202, merged_at: '2026-11-02T10:00:00Z' });
  await entry(database, {
    pr_number: 203,
    merged_at: '2026-11-03T10:00:00Z',
    user_text: null,
    audience: 'staff',
  });
  await entry(database, { pr_number: 204, merged_at: '2026-11-04T10:00:00Z' });
  // 202 approved; 204 approved then edited.
  for (const number of [202, 204])
    await approveChangelogEntry(database.db, {
      number,
      revision: 1,
      approverId: publisher,
      reason: REASON,
    });
  await editChangelogEntry(database.db, {
    staffUserId: publisher,
    number: 204,
    patch: { userText: 'You can pin two supporter notes.', revision: 1 },
  });

  const all = await listChangelog(database.db, { view: 'all' });
  assert.deepEqual(numbers(all), [204, 203, 202, 201], 'newest merged first');
  assert.equal(all.nextBefore, null);
  assert.deepEqual(
    numbers(await listChangelog(database.db, { view: 'drafts' })),
    [204, 201],
  );
  assert.deepEqual(
    numbers(await listChangelog(database.db, { view: 'users' })),
    [204, 202],
  );
  assert.deepEqual(
    numbers(await listChangelog(database.db, { view: 'staff' })),
    [203],
  );

  const byNumber = Object.fromEntries(all.rows.map((row) => [row.number, row]));
  assert.equal(byNumber[201].state, 'draft');
  assert.equal(byNumber[202].state, 'approved');
  assert.equal(byNumber[203].state, 'recorded');
  assert.equal(byNumber[204].state, 'approved');
  assert.equal(byNumber[204].unapprovedEdit, true);
  assert.equal(byNumber[202].unapprovedEdit, false);
  assert.equal(byNumber[201].waitingRequestId, null);
  assert.equal(byNumber[201].title, 'feat: pins');
  assert.equal(byNumber[201].mergedAt, '2026-11-01T10:00:00.000Z');
});

test('the list pages 50 at a time, newest merged first, by number', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  for (let i = 1; i <= 55; i += 1)
    await entry(database, {
      pr_number: 300 + i,
      merged_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    });
  const first = await listChangelog(database.db, { view: 'all' });
  assert.equal(first.rows.length, 50);
  assert.equal(first.rows[0].number, 355);
  assert.equal(first.nextBefore, 306);
  const second = await listChangelog(database.db, {
    view: 'all',
    before: first.nextBefore,
  });
  assert.deepEqual(numbers(second), [305, 304, 303, 302, 301]);
  assert.equal(second.nextBefore, null);
});

test('editing the user text bumps the revision and leaves the published copy as it was', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const editor = await staffUser(database);
  const number = await entry(database);
  await approveChangelogEntry(database.db, {
    number,
    revision: 1,
    approverId: editor,
    reason: REASON,
  });
  const edited = await editChangelogEntry(database.db, {
    staffUserId: editor,
    number,
    patch: { userText: 'You can pin notes.', audience: 'pro', revision: 1 },
  });
  assert.equal(edited.revision, 2);
  assert.equal(edited.userText, 'You can pin notes.');
  assert.equal(edited.audience, 'pro');
  assert.equal(edited.publishedText, 'You can pin a supporter note.');
  assert.equal(edited.publishedAudience, 'everyone');
  assert.equal(edited.publishedRevision, 1);
  assert.equal(edited.unapprovedEdit, true);
  const [audit] = await auditOf(database, 'changelog.edited');
  assert.equal(audit.staff_user_id, editor);
  assert.equal(audit.subject_id, String(number));
  assert.match(audit.reason, /"revision":2/);
  assert.ok(!audit.reason.includes('pin notes'), 'no text in the audit');
});

test('editing with an old revision is refused and nothing changes', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const editor = await staffUser(database);
  const number = await entry(database);
  await editChangelogEntry(database.db, {
    staffUserId: editor,
    number,
    patch: { userText: 'First edit text.', revision: 1 },
  });
  await assert.rejects(
    editChangelogEntry(database.db, {
      staffUserId: editor,
      number,
      patch: { userText: 'Second edit text.', revision: 1 },
    }),
    { code: 'CHANGELOG_EDITED_ELSEWHERE' },
  );
  const row = await rowOf(database, number);
  assert.equal(row.user_text, 'First edit text.');
  assert.equal(row.revision, 2);
  await assert.rejects(
    editChangelogEntry(database.db, {
      staffUserId: editor,
      number: 999,
      patch: { userText: 'x', revision: 1 },
    }),
    { code: 'CHANGELOG_NOT_FOUND' },
  );
  await assert.rejects(readChangelogEntry(database.db, 999), {
    code: 'CHANGELOG_NOT_FOUND',
  });
});

test('clearing the user text makes the entry staff only', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const editor = await staffUser(database);
  const number = await entry(database);
  const cleared = await editChangelogEntry(database.db, {
    staffUserId: editor,
    number,
    patch: { userText: null, revision: 1 },
  });
  assert.equal(cleared.userText, null);
  assert.equal(cleared.audience, 'staff');
  assert.equal(cleared.state, 'recorded');
  // A user text with "staff" is refused; a user text on a staff entry without an audience is for everyone.
  await assert.rejects(
    editChangelogEntry(database.db, {
      staffUserId: editor,
      number,
      patch: { userText: 'Back again.', audience: 'staff', revision: 2 },
    }),
    { code: 'INVALID_INPUT' },
  );
  const back = await editChangelogEntry(database.db, {
    staffUserId: editor,
    number,
    patch: { userText: 'Back again.', revision: 2 },
  });
  assert.equal(back.audience, 'everyone');
  assert.equal(back.state, 'draft');
});

test('approval copies text and audience at that revision, records who and when, and is audited', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const publisher = await staffUser(database, 'publisher.person@example.com');
  const number = await entry(database, { audience: 'pro' });
  const now = new Date('2026-11-06T12:00:00Z');
  const approved = await approveChangelogEntry(database.db, {
    number,
    revision: 1,
    approverId: publisher,
    reason: REASON,
    now,
  });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.publishedText, 'You can pin a supporter note.');
  assert.equal(approved.publishedAudience, 'pro');
  assert.equal(approved.publishedRevision, 1);
  assert.equal(approved.approvedAt, now.toISOString());
  assert.equal(approved.approvedBy, 'p•••@example.com', 'masked');
  const row = await rowOf(database, number);
  assert.equal(row.approved_by, publisher);
  const [audit] = await auditOf(database, 'changelog.approved');
  assert.equal(audit.staff_user_id, publisher);
  assert.equal(audit.permission, 'changelog.publish');
  assert.ok(audit.reason.startsWith(REASON));
  assert.match(audit.reason, /"number":200/);
  assert.match(audit.reason, /"revision":1/);
  assert.ok(!audit.reason.includes('supporter note'), 'no text in the audit');
  assert.deepEqual(await userVisible(database), [number]);
  // Approving the same revision again has nothing to approve; an old revision is refused.
  await assert.rejects(
    approveChangelogEntry(database.db, {
      number,
      revision: 1,
      approverId: publisher,
      reason: REASON,
    }),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    approveChangelogEntry(database.db, {
      number,
      revision: 7,
      approverId: publisher,
      reason: REASON,
    }),
    { code: 'CHANGELOG_EDITED_ELSEWHERE' },
  );
});

test('approval refuses a text naming the payment provider or claiming a licence', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const publisher = await staffUser(database);
  for (const [number, text, problems] of [
    [210, 'Payouts via Bachs are faster', 'provider_name'],
    [211, 'TipMe is now licensed', 'regulatory_claim'],
  ]) {
    await entry(database, { pr_number: number, user_text: text });
    await assert.rejects(
      approveChangelogEntry(database.db, {
        number,
        revision: 1,
        approverId: publisher,
        reason: REASON,
      }),
      (error) =>
        error.code === 'CHANGELOG_TEXT_NOT_ALLOWED' &&
        error.detail === problems,
    );
    const row = await rowOf(database, number);
    assert.equal(row.published_revision, null);
    const read = await readChangelogEntry(database.db, number);
    assert.deepEqual(read.problems, [problems]);
  }
  assert.deepEqual(await auditOf(database, 'changelog.approved'), []);
});

test('withdrawal needs a reason, hides it from the user view, and keeps it in admin as withdrawn', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const publisher = await staffUser(database);
  const number = await entry(database);
  await approveChangelogEntry(database.db, {
    number,
    revision: 1,
    approverId: publisher,
    reason: REASON,
  });
  await database.pool.query(
    `UPDATE changelog_entries SET live_at = now(), live_version = 'abcdefabcdef' WHERE pr_number = $1`,
    [number],
  );
  assert.equal((await readChangelogEntry(database.db, number)).state, 'live');
  for (const reason of ['', 'short'])
    await assert.rejects(
      withdrawChangelogEntry(database.db, {
        staffUserId: publisher,
        number,
        reason,
      }),
      { code: 'INVALID_INPUT' },
    );
  const withdrawn = await withdrawChangelogEntry(database.db, {
    staffUserId: publisher,
    number,
    reason: 'The change was rolled back today',
  });
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.withdrawnReason, 'The change was rolled back today');
  assert.deepEqual(await userVisible(database), []);
  assert.deepEqual(numbers(await listChangelog(database.db, { view: 'all' })), [
    number,
  ]);
  assert.deepEqual(
    numbers(await listChangelog(database.db, { view: 'users' })),
    [],
  );
  const [audit] = await auditOf(database, 'changelog.withdrawn');
  assert.equal(audit.staff_user_id, publisher);
  assert.ok(audit.reason.startsWith('The change was rolled back today'));
  // The published copy is kept, and the live date too.
  const row = await rowOf(database, number);
  assert.equal(row.published_revision, 1);
  assert.ok(row.live_at);
});

test('a withdrawn entry edited and approved again is shown again, and the audit says it was restored', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const publisher = await staffUser(database);
  const number = await entry(database);
  await approveChangelogEntry(database.db, {
    number,
    revision: 1,
    approverId: publisher,
    reason: REASON,
  });
  await withdrawChangelogEntry(database.db, {
    staffUserId: publisher,
    number,
    reason: 'The change was rolled back today',
  });
  // Without an edit there is nothing new to approve.
  await assert.rejects(
    approveChangelogEntry(database.db, {
      number,
      revision: 1,
      approverId: publisher,
      reason: REASON,
    }),
    { code: 'INVALID_INPUT' },
  );
  await editChangelogEntry(database.db, {
    staffUserId: publisher,
    number,
    patch: { userText: 'You can pin a note again.', revision: 1 },
  });
  const shown = await approveChangelogEntry(database.db, {
    number,
    revision: 2,
    approverId: publisher,
    reason: REASON,
  });
  assert.equal(shown.state, 'approved');
  assert.equal(shown.withdrawnAt, null);
  assert.equal(shown.withdrawnReason, null);
  assert.equal(shown.publishedText, 'You can pin a note again.');
  assert.deepEqual(await userVisible(database), [number]);
  const audits = await auditOf(database, 'changelog.approved');
  assert.equal(audits.length, 2);
  assert.match(audits[1].reason, /"restored":true/);
  assert.match(audits[0].reason, /"restored":false/);
});

test('staff text edits never touch the revision', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const editor = await staffUser(database);
  const number = await entry(database);
  const edited = await editChangelogEntry(database.db, {
    staffUserId: editor,
    number,
    patch: { staffText: 'feat: pins — Better words for staff.', revision: 1 },
  });
  assert.equal(edited.revision, 1);
  assert.equal(edited.staffText, 'feat: pins — Better words for staff.');
  // An edit that changes nothing writes nothing.
  await editChangelogEntry(database.db, {
    staffUserId: editor,
    number,
    patch: {
      userText: 'You can pin a supporter note.',
      audience: 'everyone',
      revision: 1,
    },
  });
  assert.equal((await rowOf(database, number)).revision, 1);
  assert.equal((await auditOf(database, 'changelog.edited')).length, 1);
});
