import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  createPaymentIntent,
  createQuote,
  listIssues,
  memberNotes,
  notesVisibleToBusiness,
  reportNoteAsManager,
  reportNoteAsMember,
  staffRevealNote,
  staffReviewNote,
  writeBusinessNote,
} from '../../dist/index.js';
import {
  leaveMember,
  seedBusiness,
  seedManager,
  seedMember,
} from './business-fixtures.mjs';
import { ADA, useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B5 Task 17: the member or a manager reports a note; it leaves the
// business view in the same transaction; TipMe staff read it only through a reasoned reveal and
// restore or remove it.

const [ADA_USER, TOBI_USER] = DEMO_PROFILES.map((p) => p.userId);
// Two more accounts with no page: a location manager elsewhere, and a TipMe staff member.
const DELE_USER = '00000000-0000-7000-8000-0000000de1e0';
const STAFF = '00000000-0000-7000-8000-00000000057a';
const REASON = 'Checked the note against the report.';

async function paidNote(
  database,
  memberId,
  note = { tags: ['friendly'], body: 'So kind.' },
) {
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { tipId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
    message: 'private words for Ada',
    businessMemberId: memberId,
  });
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      `UPDATE tips SET status = 'SUCCEEDED', completed_at = now() WHERE id = $1`,
      [tipId],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await writeBusinessNote(database.db, tipId, note);
  return tipId;
}

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return null;
};

test('business note flags', async (t) => {
  const database = await useDatabase(t);
  let business;
  let memberId;
  const fresh = async () => {
    await database.fresh();
    business = await seedBusiness(database, {
      owner: TOBI_USER,
      locations: [{ slug: 'vi' }, { slug: 'ikoyi' }],
    });
    await database.pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [
      DELE_USER,
      STAFF,
    ]);
    ({ memberId } = await seedMember(database, {
      locationId: business.locations[0].id,
      profileId: ADA,
    }));
  };
  const visible = async () =>
    [
      ...(await notesVisibleToBusiness(database.db, business.businessId)),
    ].sort();

  await t.test(
    'a member reports a note: it leaves the business view at once and one issue opens',
    async () => {
      await fresh();
      const reported = await paidNote(database, memberId);
      const kept = await paidNote(database, memberId);
      assert.deepEqual(await visible(), [reported, kept].sort());
      await reportNoteAsMember(database.db, {
        userId: ADA_USER,
        tipId: reported,
        reason: 'abusive',
      });
      assert.deepEqual(await visible(), [kept]);
      // A second report, by anyone, keeps the first one's time and opens nothing new.
      const [first] = (
        await database.pool.query(
          'SELECT reported_at, reported_by, reason FROM business_note_flags WHERE tip_id = $1',
          [reported],
        )
      ).rows;
      await reportNoteAsManager(database.db, {
        userId: TOBI_USER,
        businessId: business.businessId,
        tipId: reported,
        reason: 'spam',
      });
      const [second] = (
        await database.pool.query(
          'SELECT reported_at, reported_by, reason FROM business_note_flags WHERE tip_id = $1',
          [reported],
        )
      ).rows;
      assert.deepEqual(second, first);
      assert.equal(first.reported_by, 'member');
      const issues = (await listIssues(database.db, { limit: 50 })).filter(
        (issue) => issue.kind === 'business_note_reported',
      );
      assert.equal(issues.length, 1);
      assert.equal(issues[0].subject.tipId, reported);
      assert.equal(issues[0].subject.businessId, business.businessId);
      // The issue never carries the note's words.
      assert.doesNotMatch(JSON.stringify(issues), /So kind/);
      // The member's own list still shows it, marked as reported.
      const mine = await memberNotes(database.db, ADA_USER);
      const row = mine.find((note) => note.tipId === reported);
      assert.equal(row.reported, true);
      assert.equal(row.canReport, false);
      assert.equal(row.body, 'So kind.');
    },
  );

  await t.test(
    'a manager reports a note at their location; a manager of another location, or of another business, cannot (404)',
    async () => {
      await fresh();
      const tipId = await paidNote(database, memberId);
      await seedManager(database, {
        businessId: business.businessId,
        userId: DELE_USER,
        locationId: business.locations[1].id,
      });
      assert.equal(
        await code(
          reportNoteAsManager(database.db, {
            userId: DELE_USER,
            businessId: business.businessId,
            tipId,
            reason: 'spam',
          }),
        ),
        'NOT_A_MANAGER',
      );
      const other = await seedBusiness(database, { owner: STAFF });
      assert.equal(
        await code(
          reportNoteAsManager(database.db, {
            userId: STAFF,
            businessId: other.businessId,
            tipId,
            reason: 'spam',
          }),
        ),
        'NOT_A_MANAGER',
      );
      // Someone who is neither the member nor a manager can't report it as a member either.
      assert.equal(
        await code(
          reportNoteAsMember(database.db, {
            userId: TOBI_USER,
            tipId,
            reason: 'spam',
          }),
        ),
        'NO_MEMBERSHIP',
      );
      assert.equal(await database.count('business_note_flags'), 0);
      // The location manager of the member's own location can.
      await seedManager(database, {
        businessId: business.businessId,
        userId: STAFF,
        locationId: business.locations[0].id,
      });
      await reportNoteAsManager(database.db, {
        userId: STAFF,
        businessId: business.businessId,
        tipId,
        reason: 'other',
      });
      assert.deepEqual(await visible(), []);
      const [flag] = (
        await database.pool.query(
          'SELECT reported_by FROM business_note_flags WHERE tip_id = $1',
          [tipId],
        )
      ).rows;
      assert.equal(flag.reported_by, 'manager');
    },
  );

  await t.test(
    'staff read the text only through a reasoned reveal; review restore shows it again; remove hides it for good',
    async () => {
      await fresh();
      const restored = await paidNote(database, memberId);
      const removed = await paidNote(database, memberId, {
        tags: [],
        body: 'Rude words here.',
      });
      const unreported = await paidNote(database, memberId);
      for (const tipId of [restored, removed])
        await reportNoteAsMember(database.db, {
          userId: ADA_USER,
          tipId,
          reason: 'abusive',
        });
      // An unreported note is nobody's to read.
      assert.equal(
        await code(
          staffRevealNote(database.db, {
            staffUserId: STAFF,
            tipId: unreported,
            reason: REASON,
          }),
        ),
        'ISSUE_NOT_FOUND',
      );
      const revealed = await staffRevealNote(database.db, {
        staffUserId: STAFF,
        tipId: removed,
        reason: REASON,
      });
      assert.equal(revealed.body, 'Rude words here.');
      assert.equal(revealed.shownName, 'Tobi');
      assert.equal(revealed.business, 'The Yellow Chilli');
      assert.match(revealed.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(revealed.report.reason, 'abusive');
      assert.equal(revealed.report.reportedBy, 'member');
      // Nothing about the supporter or their private message comes with it.
      assert.doesNotMatch(JSON.stringify(revealed), /private words|payer/i);
      const audits = (
        await database.pool.query(
          `SELECT action, permission, subject_type, subject_id, reason FROM audit_events
            WHERE action LIKE 'business_note.%' ORDER BY created_at`,
        )
      ).rows;
      assert.deepEqual(audits, [
        {
          action: 'business_note.reveal',
          permission: 'private.view',
          subject_type: 'business_note',
          subject_id: removed,
          reason: REASON,
        },
      ]);

      await staffReviewNote(database.db, {
        staffUserId: STAFF,
        tipId: restored,
        outcome: 'restored',
        reason: REASON,
      });
      await staffReviewNote(database.db, {
        staffUserId: STAFF,
        tipId: removed,
        outcome: 'removed',
        reason: REASON,
      });
      assert.deepEqual(await visible(), [restored, unreported].sort());
      // Decided once: a second review is refused, and reporting again changes nothing.
      assert.equal(
        await code(
          staffReviewNote(database.db, {
            staffUserId: STAFF,
            tipId: removed,
            outcome: 'restored',
            reason: REASON,
          }),
        ),
        'ISSUE_RESOLVED',
      );
      await reportNoteAsMember(database.db, {
        userId: ADA_USER,
        tipId: restored,
        reason: 'spam',
      });
      assert.deepEqual(await visible(), [restored, unreported].sort());
      // Each review resolved its issue and is audited.
      const issues = (await listIssues(database.db, { limit: 50 })).filter(
        (issue) => issue.kind === 'business_note_reported',
      );
      assert.equal(issues.length, 2);
      assert.ok(issues.every((issue) => issue.status === 'resolved'));
      const reviews = (
        await database.pool.query(
          `SELECT subject_id, reason FROM audit_events WHERE action = 'business_note.review'`,
        )
      ).rows;
      assert.equal(reviews.length, 2);
      assert.ok(reviews.every((row) => row.reason.endsWith(REASON)));
      // The member still sees the removed note's place, not its words.
      const mine = await memberNotes(database.db, ADA_USER);
      const gone = mine.find((note) => note.tipId === removed);
      assert.equal(gone.removed, true);
      assert.equal(gone.body, undefined);
      assert.deepEqual(gone.tags, []);
      const back = mine.find((note) => note.tipId === restored);
      assert.equal(back.reported, false);
      assert.equal(back.removed, undefined);
      assert.equal(back.canReport, false);
    },
  );

  await t.test(
    'a member who left still sees and can report notes from that membership',
    async () => {
      await fresh();
      const tipId = await paidNote(database, memberId);
      await leaveMember(database, memberId);
      const mine = await memberNotes(database.db, ADA_USER);
      assert.equal(mine.length, 1);
      assert.deepEqual(
        { ...mine[0], date: undefined },
        {
          tipId,
          memberId,
          business: 'The Yellow Chilli',
          location: 'VI',
          shownName: 'Tobi',
          date: undefined,
          tags: ['friendly'],
          body: 'So kind.',
          reported: false,
          canReport: true,
          left: true,
        },
      );
      await reportNoteAsMember(database.db, {
        userId: ADA_USER,
        tipId,
        reason: 'other',
      });
      assert.equal(await database.count('business_note_flags'), 1);
      // Another person's list never shows it.
      assert.deepEqual(await memberNotes(database.db, TOBI_USER), []);
    },
  );
});
