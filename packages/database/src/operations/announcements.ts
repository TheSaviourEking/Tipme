import {
  ANNOUNCEMENT_AUDIENCE_WORDS,
  opsAnnouncementDraftSchema,
  opsAnnouncementEditSchema,
  type AnnouncementAudience,
  type OpsAnnouncement,
  type OpsAnnouncementDraft,
  type OpsAnnouncementEdit,
  type OpsAnnouncementList,
  type OpsAnnouncementTestSent,
} from '@tipme/contracts';
import { announcementSchema, type AnnouncementData } from '@tipme/mail';
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { announcements, approvalRequests, users } from '../schema.js';
import { recordAudit } from './audit.js';
import { maskEmail, normaliseEmail } from './email-address.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';
import {
  requestSeriousAction,
  type SeriousActionDefinition,
  type SeriousActionOutcome,
  type SeriousActionServices,
} from './serious-actions.js';
import { checkedReason, withAuditChange } from './staff.js';

/*
 * Staff announcements by email (owner-approved, 14 Nov 2026). Staff write a draft, preview it and
 * send themselves a test; sending is the serious action `announcement.send`, decided by a second
 * person, which recounts the audience and starts the send. The worker then calls
 * `queueAnnouncementBatch` on a steady clock: each call queues the next people, by user id, in one
 * transaction with the progress, and each email's dedupe key is the announcement and the person, so
 * a repeat after a restart, or a second worker, queues nobody twice. Every step is audited with ids
 * and counts, never the words.
 */

export const ANNOUNCEMENT_SEND_ACTION = 'announcement.send';
const SUBJECT = 'announcement';
const PERMISSION = 'announcements.send';
const LIST_LIMIT = 50;

type Row = typeof announcements.$inferSelect;

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** What the email template takes: the stored words, and the button only when there is one. */
export function announcementMailData(row: {
  subject: string;
  preheader: string;
  text: string;
  buttonLabel: string | null;
  buttonUrl: string | null;
}): AnnouncementData {
  return announcementSchema.parse({
    subject: row.subject,
    preheader: row.preheader,
    text: row.text,
    ...(row.buttonLabel && row.buttonUrl
      ? { button: { label: row.buttonLabel, url: row.buttonUrl } }
      : {}),
  });
}

/**
 * Who an audience is. A confirmed email on a live account, whose marketing switch is on (opt-in:
 * no row is off) and whose guides and news switch isn't off. The same rules are checked again for
 * each email when it is sent (mailGate), and suppressed addresses are dropped there.
 */
function audienceWhere(audience: AnnouncementAudience): SQL {
  const base = sql`u.email IS NOT NULL AND u.email_verified_at IS NOT NULL AND u.deleted_at IS NULL
    AND mp.marketing IS TRUE AND mp.engagement IS NOT FALSE`;
  switch (audience) {
    case 'everyone':
      return base;
    case 'free':
      return sql`${base} AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id AND p.plan = 'pro')`;
    case 'pro':
      return sql`${base} AND EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id AND p.plan = 'pro')`;
    case 'business_owners':
      return sql`${base} AND EXISTS (SELECT 1 FROM business_managers bm
        WHERE bm.user_id = u.id AND bm.role = 'owner' AND bm.removed_at IS NULL)`;
  }
}

/** How many people an audience reaches now (or, with a cutoff, among accounts made by then). */
export function countAnnouncementAudience(
  db: Database | Tx,
  audience: AnnouncementAudience,
  cutoff?: Date,
): Promise<number> {
  return guarded(async () => {
    const result = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM users u
        LEFT JOIN mail_preferences mp ON mp.user_id = u.id
        WHERE ${audienceWhere(audience)}
        ${cutoff ? sql`AND u.created_at <= ${cutoff.toISOString()}::timestamptz` : sql``}`,
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

async function waitingRequests(
  db: Database | Tx,
  ids: string[],
  now: Date,
): Promise<Map<string, string>> {
  const waiting = new Map<string, string>();
  if (ids.length === 0) return waiting;
  const id = sql<string>`${approvalRequests.payload}->>'id'`;
  const rows = await db
    .select({ requestId: approvalRequests.id, id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.action, ANNOUNCEMENT_SEND_ACTION),
        eq(approvalRequests.status, 'pending'),
        gt(approvalRequests.expiresAt, now),
        inArray(id, ids),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt));
  for (const row of rows)
    if (!waiting.has(row.id)) waiting.set(row.id, row.requestId);
  return waiting;
}

async function toView(
  db: Database | Tx,
  row: Row,
  waitingRequestId: string | null,
): Promise<OpsAnnouncement> {
  const audience = row.audience as AnnouncementAudience;
  return {
    id: row.id,
    subject: row.subject,
    preheader: row.preheader,
    text: row.text,
    buttonLabel: row.buttonLabel,
    buttonUrl: row.buttonUrl,
    audience,
    state:
      row.status === 'draft' && waitingRequestId
        ? 'waiting'
        : (row.status as OpsAnnouncement['state']),
    revision: row.revision,
    audienceCount:
      row.status === 'draft'
        ? await countAnnouncementAudience(db, audience)
        : null,
    recipientCount: row.recipientCount,
    queuedCount: row.queuedCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sendStartedAt: iso(row.sendStartedAt),
    finishedAt: iso(row.finishedAt),
    cancelledAt: iso(row.cancelledAt),
    waitingRequestId,
  };
}

async function viewOf(db: Database | Tx, row: Row, now: Date) {
  const waiting = await waitingRequests(db, [row.id], now);
  return toView(db, row, waiting.get(row.id) ?? null);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rowOrThrow(
  db: Database | Tx,
  id: string,
  lock = false,
): Promise<Row> {
  if (!UUID.test(id)) throw new OperationError('ANNOUNCEMENT_NOT_FOUND');
  const query = db.select().from(announcements).where(eq(announcements.id, id));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new OperationError('ANNOUNCEMENT_NOT_FOUND');
  return row;
}

/** The draft's words as stored; refused unless the email template would take them too. */
function checkedDraft(input: unknown): OpsAnnouncementDraft {
  const parsed = opsAnnouncementDraftSchema.safeParse(input);
  if (!parsed.success) throw new OperationError('INVALID_INPUT');
  try {
    announcementMailData(parsed.data);
  } catch {
    throw new OperationError('INVALID_INPUT');
  }
  return parsed.data;
}

export function listAnnouncements(
  db: Database,
  input: { now?: Date } = {},
): Promise<OpsAnnouncementList> {
  return guarded(async () => {
    const rows = await db
      .select()
      .from(announcements)
      .orderBy(desc(announcements.createdAt), desc(announcements.id))
      .limit(LIST_LIMIT);
    const waiting = await waitingRequests(
      db,
      rows.map((row) => row.id),
      input.now ?? new Date(),
    );
    const views: OpsAnnouncement[] = [];
    for (const row of rows)
      views.push(await toView(db, row, waiting.get(row.id) ?? null));
    return { rows: views };
  });
}

export function readAnnouncement(
  db: Database,
  id: string,
  now?: Date,
): Promise<OpsAnnouncement> {
  return guarded(async () =>
    viewOf(db, await rowOrThrow(db, id), now ?? new Date()),
  );
}

export function createAnnouncement(
  db: Database,
  input: { staffUserId: string; draft: OpsAnnouncementDraft; now?: Date },
): Promise<OpsAnnouncement> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const draft = checkedDraft(input.draft);
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(announcements)
        .values({
          id: newId(),
          ...draft,
          createdBy: input.staffUserId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'announcement.created',
        permission: PERMISSION,
        subjectType: SUBJECT,
        subjectId: row!.id,
        reason: withAuditChange('Wrote an announcement', {
          revision: row!.revision,
          audience: draft.audience,
        }),
        now,
      });
      return viewOf(tx, row!, now);
    });
  });
}

/** Edits a draft at the revision the editor read. Any asked-for approval then goes stale. */
export function editAnnouncement(
  db: Database,
  input: {
    staffUserId: string;
    id: string;
    edit: OpsAnnouncementEdit;
    now?: Date;
  },
): Promise<OpsAnnouncement> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const parsed = opsAnnouncementEditSchema.safeParse(input.edit);
    if (!parsed.success) throw new OperationError('INVALID_INPUT');
    const { revision, ...rest } = parsed.data;
    const draft = checkedDraft(rest);
    return db.transaction(async (tx) => {
      const row = await rowOrThrow(tx, input.id, true);
      if (row.status !== 'draft')
        throw new OperationError('ANNOUNCEMENT_NOT_DRAFT');
      if (row.revision !== revision)
        throw new OperationError('ANNOUNCEMENT_EDITED_ELSEWHERE');
      const fields = (Object.keys(draft) as (keyof typeof draft)[]).filter(
        (key) => draft[key] !== row[key],
      );
      if (fields.length === 0) return viewOf(tx, row, now);
      const [updated] = await tx
        .update(announcements)
        .set({ ...draft, revision: row.revision + 1, updatedAt: now })
        .where(eq(announcements.id, row.id))
        .returning();
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'announcement.edited',
        permission: PERMISSION,
        subjectType: SUBJECT,
        subjectId: row.id,
        reason: withAuditChange('Edited an announcement', {
          revision: updated!.revision,
          fields,
        }),
        now,
      });
      return viewOf(tx, updated!, now);
    });
  });
}

/**
 * Sends the current words to the staff member's own address, now. Not tied to their account, so
 * their own email switches don't hold it back, and so it has no settings link of its own.
 */
export function sendAnnouncementTest(
  db: Database,
  sealing: MailSealing,
  input: { staffUserId: string; id: string; now?: Date },
): Promise<OpsAnnouncementTestSent> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await rowOrThrow(tx, input.id);
      const [staffUser] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, input.staffUserId));
      const to = staffUser?.email ? normaliseEmail(staffUser.email) : null;
      if (!to) throw new OperationError('INVALID_INPUT');
      await enqueueMail(tx, sealing, {
        type: 'announcement',
        to,
        userId: null,
        data: announcementMailData(row),
        dedupeKey: `announcement_test:${row.id}:${newId()}`,
        now,
      });
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'announcement.test_sent',
        permission: PERMISSION,
        subjectType: SUBJECT,
        subjectId: row.id,
        reason: withAuditChange('Sent a test of an announcement to themself', {
          revision: row.revision,
        }),
        now,
      });
      return { toHint: maskEmail(to) };
    }),
  );
}

/**
 * Stops a send (or drops a draft) at once: no batch queues anything after this commits. Mail
 * already queued still goes. Cancelling a cancelled one changes nothing; a finished one is refused.
 */
export function cancelAnnouncement(
  db: Database,
  input: { staffUserId: string; id: string; reason: string; now?: Date },
): Promise<OpsAnnouncement> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    return db.transaction(async (tx) => {
      const row = await rowOrThrow(tx, input.id, true);
      if (row.status === 'cancelled') return viewOf(tx, row, now);
      if (row.status === 'sent')
        throw new OperationError('ANNOUNCEMENT_NOT_DRAFT');
      const [updated] = await tx
        .update(announcements)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          cancelledBy: input.staffUserId,
          updatedAt: now,
        })
        .where(eq(announcements.id, row.id))
        .returning();
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'announcement.cancelled',
        permission: PERMISSION,
        subjectType: SUBJECT,
        subjectId: row.id,
        reason: withAuditChange(reason, {
          was: row.status,
          queued: row.queuedCount,
          recipients: row.recipientCount,
        }),
        now,
      });
      return viewOf(tx, updated!, now);
    });
  });
}

/* The approvals flow */

export interface AnnouncementSendPayload {
  id: string;
  revision: number;
  /**
   * Who it reached when asked, for the approver to read. The summary must not change while it
   * waits, so it holds this count; the run counts again, and that is the N while sending.
   */
  countWhenAsked: number;
}

/** The checks asking and approving both make: a draft at that revision, with someone to send to. */
async function sendable(
  tx: Database | Tx,
  payload: AnnouncementSendPayload,
  now: Date,
): Promise<{ row: Row; count: number }> {
  if (
    typeof payload?.id !== 'string' ||
    !Number.isSafeInteger(payload?.revision) ||
    !Number.isSafeInteger(payload?.countWhenAsked)
  )
    throw new OperationError('INVALID_INPUT');
  const row = await rowOrThrow(tx, payload.id);
  if (row.status !== 'draft')
    throw new OperationError('ANNOUNCEMENT_NOT_DRAFT');
  if (row.revision !== payload.revision)
    throw new OperationError('ANNOUNCEMENT_EDITED_ELSEWHERE');
  const count = await countAnnouncementAudience(
    tx,
    row.audience as AnnouncementAudience,
    now,
  );
  if (count === 0) throw new OperationError('ANNOUNCEMENT_NO_RECIPIENTS');
  return { row, count };
}

const people = (count: number) =>
  `${count.toLocaleString('en-NG')} ${count === 1 ? 'person' : 'people'}`;

/**
 * `announcement.send`: a second person holding announcements.send approves sending the revision
 * asked about. The run recounts the audience at that moment (the N shown while sending) and starts
 * the send; the worker does the rest. An edit, a cancel or a start while waiting makes it stale.
 */
export const announcementSendAction: SeriousActionDefinition<AnnouncementSendPayload> =
  {
    name: ANNOUNCEMENT_SEND_ACTION,
    permission: PERMISSION,
    validate: async (tx, payload, check) => {
      await sendable(tx, payload, check.now);
    },
    target: ({ id }) => `announcement:${id}`,
    current: async (tx, { id }) => {
      const [row] = await tx
        .select({
          revision: announcements.revision,
          status: announcements.status,
        })
        .from(announcements)
        .where(eq(announcements.id, id));
      return row ?? null;
    },
    describe: async (tx, payload) => {
      const { row } = await sendable(tx, payload, new Date());
      const audience =
        ANNOUNCEMENT_AUDIENCE_WORDS[row.audience as AnnouncementAudience];
      return `Email the announcement “${row.subject}” to ${audience.toLowerCase()}: ${people(payload.countWhenAsked)} when asked, counted again when it starts`;
    },
    run: async (tx, payload, context) => {
      const { row, count } = await sendable(tx, payload, context.now);
      await tx
        .select({ id: announcements.id })
        .from(announcements)
        .where(eq(announcements.id, row.id))
        .for('update');
      const [updated] = await tx
        .update(announcements)
        .set({
          status: 'sending',
          recipientCount: count,
          queuedCount: 0,
          cursorUserId: null,
          cutoff: context.now,
          requestedBy: context.actorId,
          approvedBy: context.approverId,
          sendStartedAt: context.now,
          updatedAt: context.now,
        })
        .where(
          and(
            eq(announcements.id, row.id),
            eq(announcements.status, 'draft'),
            eq(announcements.revision, payload.revision),
          ),
        )
        .returning();
      if (!updated) throw new OperationError('ANNOUNCEMENT_EDITED_ELSEWHERE');
      await recordAudit(tx, {
        staffUserId: context.approverId ?? context.actorId,
        action: 'announcement.send_started',
        permission: PERMISSION,
        subjectType: SUBJECT,
        subjectId: row.id,
        reason: withAuditChange(context.reason, {
          revision: row.revision,
          audience: row.audience,
          recipients: count,
          askedBy: context.actorId,
          approvedBy: context.approverId,
        }),
        now: context.now,
      });
      return { id: row.id, recipientCount: count };
    },
  };

/** Asks a second person to send the revision the asker read (POST …/send). */
export function askToSendAnnouncement(
  db: Database,
  input: {
    actorId: string;
    grantId: string;
    id: string;
    revision: number;
    reason: string;
    services: SeriousActionServices;
    now?: Date;
  },
): Promise<SeriousActionOutcome> {
  return guarded(async () => {
    const row = await rowOrThrow(db, input.id);
    const countWhenAsked = await countAnnouncementAudience(
      db,
      row.audience as AnnouncementAudience,
    );
    return requestSeriousAction(db, {
      name: ANNOUNCEMENT_SEND_ACTION,
      payload: {
        id: input.id,
        revision: input.revision,
        countWhenAsked,
      } satisfies AnnouncementSendPayload,
      actorId: input.actorId,
      grantId: input.grantId,
      reason: input.reason,
      services: input.services,
      ...(input.now ? { now: input.now } : {}),
    });
  });
}

/* The worker's part */

export interface AnnouncementBatchResult {
  /** The announcement this batch worked on, or null when nothing is sending. */
  announcementId: string | null;
  /** People handed to the mail queue in this batch (none twice: see the dedupe key). */
  queued: number;
  /** True when this batch found nobody left and marked it sent. */
  finished: boolean;
}

/**
 * Queues the next `limit` people of the oldest announcement that is sending, in one transaction
 * with its progress. A second worker skips the locked row. A batch that finds fewer than `limit`
 * people left finishes the send. Someone whose preferences changed since the approval is skipped
 * here, and again at send time.
 */
export function queueAnnouncementBatch(
  db: Database,
  sealing: MailSealing,
  input: { now: Date; limit: number },
): Promise<AnnouncementBatchResult> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(announcements)
        .where(eq(announcements.status, 'sending'))
        .orderBy(asc(announcements.createdAt), asc(announcements.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return { announcementId: null, queued: 0, finished: false };
      const limit = Math.max(1, Math.floor(input.limit));
      const found = await tx.execute<{ id: string; email: string }>(
        sql`SELECT u.id, u.email FROM users u
          LEFT JOIN mail_preferences mp ON mp.user_id = u.id
          WHERE ${audienceWhere(row.audience as AnnouncementAudience)}
            AND u.created_at <= ${(row.cutoff ?? input.now).toISOString()}::timestamptz
            ${row.cursorUserId ? sql`AND u.id > ${row.cursorUserId}::uuid` : sql``}
          ORDER BY u.id
          LIMIT ${limit}`,
      );
      const data = announcementMailData(row);
      let queued = 0;
      for (const person of found.rows) {
        // An address that can't be mailed is passed over; it never holds back the rest.
        const to = normaliseEmail(person.email);
        if (!to) continue;
        await enqueueMail(tx, sealing, {
          type: 'announcement',
          to,
          userId: person.id,
          data,
          dedupeKey: `announcement:${row.id}:${person.id}`,
          now: input.now,
        });
        queued += 1;
      }
      const finished = found.rows.length < limit;
      const last = found.rows[found.rows.length - 1];
      await tx
        .update(announcements)
        .set({
          queuedCount: row.queuedCount + queued,
          ...(last ? { cursorUserId: last.id } : {}),
          ...(finished ? { status: 'sent', finishedAt: input.now } : {}),
          updatedAt: input.now,
        })
        .where(eq(announcements.id, row.id));
      if (finished)
        await recordAudit(tx, {
          staffUserId: null,
          action: 'announcement.sent',
          permission: PERMISSION,
          subjectType: SUBJECT,
          subjectId: row.id,
          reason: withAuditChange('Every email of the announcement is queued', {
            queued: row.queuedCount + queued,
            recipients: row.recipientCount,
          }),
          now: input.now,
        });
      return { announcementId: row.id, queued, finished };
    }),
  );
}
