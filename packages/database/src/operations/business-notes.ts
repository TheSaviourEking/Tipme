import {
  businessNoteRequestSchema,
  type BusinessNoteRequest,
  type BusinessNoteTag,
  type NoteReport,
  type NoteReview,
  type OpsBusinessNote,
  type WorkNoteView,
} from '@tipme/contracts';
import { NOTE_WINDOW_DAYS } from '@tipme/domain';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { recordAudit } from './audit.js';
import { managerOf } from './business-access.js';
import { guarded, OperationError } from './errors.js';
import { markResolved, openIssue } from './issues.js';

// TipMe for businesses, PR B5: the supporter's note about the person, after paying. It never
// touches the tip: no posting, status or amount reads it. Its words are never logged, put in
// analytics or in an issue; staff read them only through a reasoned, audited reveal.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** The window (M9) as an instant: a tip completed at or after this may still take its note. */
export const noteWindowStart = (now: Date) =>
  new Date(now.getTime() - NOTE_WINDOW_DAYS * DAY_MS);

/**
 * A note the business may see: not reported, or reported and restored by TipMe staff. A pending
 * report hides it at once (owner's answer Q4); a removed one never shows again. B7's reads use
 * this with the note's tip id; the membership rule (M6, a person who left) is the reader's.
 */
export const noteShownToBusiness = (tipId: SQLWrapper): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM business_note_flags f
                   WHERE f.tip_id = ${tipId} AND f.outcome IS DISTINCT FROM 'restored')`;

/**
 * Writes the supporter's one note for a paid tip made at a business, within NOTE_WINDOW_DAYS of
 * payment. The member comes from the tip, never from the request. Anything else (a plain tip,
 * unpaid, too late, already written, unknown) is NOTE_NOT_OPEN; text that the contract refuses
 * (links, emails, phone numbers, too long, nothing at all) is NOTE_TEXT_REFUSED.
 */
export function writeBusinessNote(
  db: Database,
  tipId: string,
  input: BusinessNoteRequest,
  now: Date = new Date(),
): Promise<void> {
  return guarded(async () => {
    if (!UUID.test(tipId)) throw new OperationError('NOTE_NOT_OPEN');
    // Re-checked here for every caller, not only the HTTP route.
    const parsed = businessNoteRequestSchema.safeParse(input);
    if (!parsed.success) throw new OperationError('NOTE_TEXT_REFUSED');
    const { tags, body } = parsed.data;
    // One statement: the checks and the insert can't race, and the primary key keeps it to one.
    const inserted = await db.execute<{ tip_id: string }>(sql`
      INSERT INTO business_notes (tip_id, member_id, tags, body, created_at)
      SELECT t.id, t.business_member_id, ${sql.param(tags)}::text[], ${body ?? null}, ${now}
        FROM tips t
       WHERE t.id = ${tipId}
         AND t.status = 'SUCCEEDED'
         AND t.business_member_id IS NOT NULL
         AND t.completed_at >= ${noteWindowStart(now)}
      ON CONFLICT (tip_id) DO NOTHING
      RETURNING tip_id`);
    if (!inserted.rows[0]) throw new OperationError('NOTE_NOT_OPEN');
  });
}

type NoteRow = {
  tip_id: string;
  member_id: string;
  shown_name: string;
  business_id: string;
  business: string;
  location_id: string;
  location: string;
  left_at: Date | string | null;
  member_user_id: string;
  date: string;
  tags: string[];
  body: string | null;
  // Raw rows: the driver may hand timestamps back as text, so they are read through iso().
  reported_at: Date | string | null;
  reported_by: string | null;
  reason: string | null;
  reviewed_at: Date | string | null;
  outcome: string | null;
};

const NOTE_SELECT = sql`
  SELECT n.tip_id, n.member_id, bm.shown_name, b.id AS business_id, b.name AS business,
         l.id AS location_id, l.name AS location, bm.left_at, p.user_id AS member_user_id,
         to_char(n.created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD') AS date,
         n.tags, n.body, f.reported_at, f.reported_by, f.reason, f.reviewed_at, f.outcome
    FROM business_notes n
    JOIN business_members bm ON bm.id = n.member_id
    JOIN profiles p ON p.id = bm.profile_id
    JOIN business_locations l ON l.id = bm.location_id
    JOIN businesses b ON b.id = l.business_id
    LEFT JOIN business_note_flags f ON f.tip_id = n.tip_id`;

async function noteById(
  db: Database | Tx,
  tipId: string,
): Promise<NoteRow | null> {
  if (!UUID.test(tipId)) return null;
  const rows = await db.execute<NoteRow>(
    sql`${NOTE_SELECT} WHERE n.tip_id = ${tipId}`,
  );
  return rows.rows[0] ?? null;
}

/**
 * Hides the note from the business and opens one issue, in one transaction. A second report keeps
 * the first one's time and reason; a note TipMe already decided stays decided.
 */
async function flagNote(
  db: Database,
  note: NoteRow,
  reportedBy: 'member' | 'manager',
  reason: NoteReport['reason'],
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO business_note_flags (tip_id, reported_at, reported_by, reason)
      VALUES (${note.tip_id}, ${now}, ${reportedBy}, ${reason})
      ON CONFLICT (tip_id) DO NOTHING`);
    await openIssue(tx, {
      dedupeKey: `business_note.${note.tip_id}`,
      kind: 'business_note_reported',
      subject: { tipId: note.tip_id, businessId: note.business_id },
      now,
    });
  });
}

/** The person reports a note about one of their own memberships, current or past. */
export function reportNoteAsMember(
  db: Database,
  input: {
    userId: string;
    tipId: string;
    reason: NoteReport['reason'];
    now?: Date;
  },
): Promise<void> {
  return guarded(async () => {
    const note = await noteById(db, input.tipId);
    if (!note || note.member_user_id !== input.userId)
      throw new OperationError('NO_MEMBERSHIP');
    await flagNote(db, note, 'member', input.reason, input.now ?? new Date());
  });
}

/** An owner, or the manager of the note's location, reports it. Anyone else: NOT_A_MANAGER (404). */
export function reportNoteAsManager(
  db: Database,
  input: {
    userId: string;
    businessId: string;
    tipId: string;
    reason: NoteReport['reason'];
    now?: Date;
  },
): Promise<void> {
  return guarded(async () => {
    const note = await noteById(db, input.tipId);
    if (!note || note.business_id !== input.businessId)
      throw new OperationError('NOT_A_MANAGER');
    await managerOf(db, input.userId, input.businessId, {
      locationId: note.location_id,
    });
    await flagNote(db, note, 'manager', input.reason, input.now ?? new Date());
  });
}

const tagsOf = (tags: string[]) => tags as BusinessNoteTag[];

/**
 * The person's own notes, every membership, newest first. A note TipMe removed keeps its place
 * as "Removed by TipMe" with its words and tags held back.
 */
export function memberNotes(
  db: Database,
  userId: string,
): Promise<WorkNoteView[]> {
  return guarded(async () => {
    const rows = await db.execute<NoteRow>(sql`${NOTE_SELECT}
      WHERE p.user_id = ${userId}
      ORDER BY n.created_at DESC, n.tip_id DESC
      LIMIT 200`);
    return rows.rows.map((row): WorkNoteView => {
      const removed = row.outcome === 'removed';
      return {
        tipId: row.tip_id,
        memberId: row.member_id,
        business: row.business,
        location: row.location,
        shownName: row.shown_name,
        date: row.date,
        tags: removed ? [] : tagsOf(row.tags),
        ...(row.body !== null && !removed ? { body: row.body } : {}),
        // Waiting for TipMe: hidden from the business meanwhile.
        reported: row.reported_at !== null && row.outcome === null,
        ...(removed ? { removed: true } : {}),
        canReport: row.reported_at === null,
        left: row.left_at !== null,
      };
    });
  });
}

/** Which of a business's notes it may see now: shown (above) and the person still works there (M6). */
export function notesVisibleToBusiness(
  db: Database,
  businessId: string,
): Promise<Set<string>> {
  return guarded(async () => {
    if (!UUID.test(businessId)) return new Set<string>();
    const rows = await db.execute<{ tip_id: string }>(sql`
      SELECT n.tip_id
        FROM business_notes n
        JOIN business_members bm ON bm.id = n.member_id
        JOIN business_locations l ON l.id = bm.location_id
       WHERE l.business_id = ${businessId}
         AND bm.left_at IS NULL
         AND ${noteShownToBusiness(sql`n.tip_id`)}`);
    return new Set(rows.rows.map((row) => row.tip_id));
  });
}

const iso = (at: Date | string) => new Date(at).toISOString();

function opsView(row: NoteRow): OpsBusinessNote {
  return {
    tipId: row.tip_id,
    business: row.business,
    location: row.location,
    shownName: row.shown_name,
    date: row.date,
    tags: tagsOf(row.tags),
    ...(row.body !== null ? { body: row.body } : {}),
    report: {
      reportedAt: iso(row.reported_at as Date | string),
      reportedBy: row.reported_by as OpsBusinessNote['report']['reportedBy'],
      reason: row.reason as OpsBusinessNote['report']['reason'],
      ...(row.outcome
        ? {
            outcome: row.outcome as NonNullable<
              OpsBusinessNote['report']['outcome']
            >,
          }
        : {}),
      ...(row.reviewed_at ? { reviewedAt: iso(row.reviewed_at) } : {}),
    },
  };
}

/**
 * TipMe staff read a reported note, with a reason, audited (access-control rule 6). Only a
 * reported note can be read: an unreported one is nobody's business at TipMe (ISSUE_NOT_FOUND).
 * Nothing about the supporter comes with it.
 */
export function staffRevealNote(
  db: Database,
  input: { staffUserId: string; tipId: string; reason: string; now?: Date },
): Promise<OpsBusinessNote> {
  return guarded(async () => {
    const note = await noteById(db, input.tipId);
    if (!note || note.reported_at === null)
      throw new OperationError('ISSUE_NOT_FOUND');
    await recordAudit(db, {
      staffUserId: input.staffUserId,
      action: 'business_note.reveal',
      permission: 'private.view',
      subjectType: 'business_note',
      subjectId: note.tip_id,
      reason: input.reason,
      now: input.now,
    });
    return opsView(note);
  });
}

/**
 * TipMe staff decide a report, once: restored shows the note to the business again, removed keeps
 * the row but the business never sees it again. Audited, and it resolves the note's issue.
 */
export function staffReviewNote(
  db: Database,
  input: {
    staffUserId: string;
    tipId: string;
    outcome: NoteReview['outcome'];
    reason: string;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      if (!UUID.test(input.tipId)) throw new OperationError('ISSUE_NOT_FOUND');
      const decided = await tx.execute<{ tip_id: string }>(sql`
        UPDATE business_note_flags
           SET reviewed_at = ${now}, reviewed_by = ${input.staffUserId}, outcome = ${input.outcome}
         WHERE tip_id = ${input.tipId} AND reviewed_at IS NULL
        RETURNING tip_id`);
      if (!decided.rows[0]) {
        const exists = await tx.execute(
          sql`SELECT 1 FROM business_note_flags WHERE tip_id = ${input.tipId}`,
        );
        throw new OperationError(
          exists.rows[0] ? 'ISSUE_RESOLVED' : 'ISSUE_NOT_FOUND',
        );
      }
      const reason = `${input.outcome === 'restored' ? 'Restored' : 'Removed'}. ${input.reason}`;
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'business_note.review',
        permission: 'issues.resolve',
        subjectType: 'business_note',
        subjectId: input.tipId,
        reason,
        now,
      });
      const issue = await tx.execute<{ id: string }>(sql`
        SELECT id FROM issues WHERE dedupe_key = ${`business_note.${input.tipId}`} AND status = 'open'`);
      // Staff may already have closed the issue by hand; the decision still stands.
      if (issue.rows[0])
        await markResolved(tx, {
          issueId: issue.rows[0].id,
          resolvedBy: input.staffUserId,
          staffUserId: input.staffUserId,
          reason,
          now,
        });
    }),
  );
}
