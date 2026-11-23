import {
  ANNOUNCEMENT_AUDIENCE_WORDS,
  announcementDailyLimitOf,
  opsAnnouncementDraftSchema,
  opsAnnouncementEditSchema,
  type AnnouncementAudience,
  type AnnouncementKind,
  type OpsAnnouncement,
  type OpsAnnouncementDailyLimit,
  type OpsAnnouncementDraft,
  type OpsAnnouncementEdit,
  type OpsAnnouncementList,
  type OpsAnnouncementTestSent,
} from '@tipme/contracts';
import {
  announcementSchema,
  MAIL_TYPES,
  type AnnouncementData,
} from '@tipme/mail';
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  announcements,
  approvalRequests,
  displaySettings,
  users,
} from '../schema.js';
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

/** The email each kind is sent as: news is marketing, a service notice is account mail. */
export const announcementMailType = (kind: string) =>
  kind === 'service' ? 'service_notice' : 'announcement';

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
function audienceWhere(
  audience: AnnouncementAudience,
  kind: AnnouncementKind,
): SQL {
  const live = sql`u.email IS NOT NULL AND u.email_verified_at IS NOT NULL AND u.deleted_at IS NULL`;
  // A service notice (fees, terms) goes to every confirmed, live account: the owner's ruling.
  if (kind === 'service') return live;
  const base = sql`${live} AND mp.marketing IS TRUE AND mp.engagement IS NOT FALSE`;
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
  options: { kind?: AnnouncementKind; cutoff?: Date } = {},
): Promise<number> {
  const { kind = 'news', cutoff } = options;
  return guarded(async () => {
    const result = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM users u
        LEFT JOIN mail_preferences mp ON mp.user_id = u.id
        WHERE ${audienceWhere(audience, kind)}
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
    kind: row.kind as AnnouncementKind,
    state:
      row.status === 'draft' && waitingRequestId
        ? 'waiting'
        : (row.status as OpsAnnouncement['state']),
    revision: row.revision,
    audienceCount:
      row.status === 'draft'
        ? await countAnnouncementAudience(db, audience, {
            kind: row.kind as AnnouncementKind,
          })
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
): Promise<Omit<OpsAnnouncementList, 'setUp'>> {
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
    return {
      rows: views,
      dailyLimit: await announcementDailyUse(db, input.now ?? new Date()),
    };
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
        type: announcementMailType(row.kind),
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
  services?: SeriousActionServices,
): Promise<{ row: Row; count: number }> {
  // Only the app knows its settings; a caller without them (tests of the flow) isn't checking.
  if (services && services.announcementSender === null)
    throw new OperationError('ANNOUNCEMENT_EMAIL_NOT_SET_UP');
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
    { kind: row.kind as AnnouncementKind, cutoff: now },
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
      await sendable(tx, payload, check.now, check.services);
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
      const kind =
        row.kind === 'service'
          ? 'Service notice: goes to everyone.'
          : 'News: only people who turned on news and announcements.';
      return `${kind} Email “${row.subject}” to ${audience.toLowerCase()}: ${people(payload.countWhenAsked)} when asked, counted again when it starts`;
    },
    run: async (tx, payload, context) => {
      const { row, count } = await sendable(
        tx,
        payload,
        context.now,
        context.services,
      );
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
      { kind: row.kind as AnnouncementKind },
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

/* The daily limit (owner, 15 Nov 2026) */

const DAY_MS = 86_400_000;
const DAILY_LIMIT_KEY = 'announcement_daily_limit';
/** Advisory lock key (any fixed bigint): one batch at a time counts and queues against the limit. */
const DAILY_LIMIT_LOCK = 7_316_100_215;

/** Every email type sent through the announcement provider (Brevo): announcements, notices, tests. */
const BULK_TYPES = Object.entries(MAIL_TYPES)
  .filter(([, type]) => type.bulk)
  .map(([id]) => id);
/** Every other type: codes, receipts and alerts, which count once sent through Brevo. */
const OTHER_TYPES = Object.entries(MAIL_TYPES)
  .filter(([, type]) => !type.bulk)
  .map(([id]) => id);

/** The limit staff set in Switches, or the default (300) while unset. */
export async function announcementDailyLimit(
  db: Database | Tx,
): Promise<number> {
  const [row] = await db
    .select({ value: displaySettings.value })
    .from(displaySettings)
    .where(eq(displaySettings.key, DAILY_LIMIT_KEY));
  return announcementDailyLimitOf(row?.value);
}

/**
 * How much of the daily limit is used, from the mail queue itself (no counter that could drift).
 * Brevo's free plan allows 300 a day and we don't know the hour its day starts, so the window rolls:
 * an email counts while it waits in the queue (its credit is still to be used, however old it is)
 * and for 24 hours after it was sent. One never sent (skipped, suppressed, failed) used no credit.
 * Codes and receipts sent through Brevo (BREVO_TRANSACTIONAL=on) use the same account's credits, so
 * they count once sent, and one announcement can't use up what codes need (review, 23 Nov 2026).
 * They are never held back by the limit: only announcement batches are.
 */
export async function announcementDailyUse(
  db: Database | Tx,
  now: Date,
): Promise<OpsAnnouncementDailyLimit> {
  const limit = await announcementDailyLimit(db);
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const list = (names: readonly string[]) =>
    sql.join(
      names.map((type) => sql`${type}`),
      sql`, `,
    );
  const types = list(BULK_TYPES);
  // Two branches, each bounded by the window through (type, sent_at), so the count reads one
  // day's mail: `provider = 'brevo'` alone would read every Brevo message ever sent (re-review N1).
  // The provider test is written as an expression on purpose, so the planner can't AND in the
  // (provider, provider_message_id) index, which also holds every Brevo message ever sent.
  const result = await db.execute<{
    waiting: number;
    sent: number;
    oldest: string | Date | null;
  }>(
    sql`WITH recent AS (
      SELECT sent_at FROM mail_messages
        WHERE type IN (${types}) AND sent_at > ${since}::timestamptz
          AND status NOT IN ('queued', 'sending')
      UNION ALL
      SELECT sent_at FROM mail_messages
        WHERE type IN (${list(OTHER_TYPES)}) AND coalesce(provider, '') = 'brevo'
          AND sent_at > ${since}::timestamptz
          AND status NOT IN ('queued', 'sending')
    )
    SELECT
      (SELECT count(*)::int FROM mail_messages
        WHERE type IN (${types}) AND status IN ('queued', 'sending')) AS waiting,
      (SELECT count(*)::int FROM recent) AS sent,
      (SELECT min(sent_at) FROM recent) AS oldest`,
  );
  const row = result.rows[0];
  const used = Number(row?.waiting ?? 0) + Number(row?.sent ?? 0);
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    freesAt: oldest ? new Date(oldest.getTime() + DAY_MS).toISOString() : null,
  };
}

/* The worker's part */

export interface AnnouncementBatchResult {
  /** The announcement this batch worked on, or null when nothing is sending. */
  announcementId: string | null;
  /** People handed to the mail queue in this batch (none twice: see the dedupe key). */
  queued: number;
  /** True when this batch found nobody left and marked it sent. */
  finished: boolean;
  /** True when the daily limit held people back: the send waits, still `sending`. */
  paused: boolean;
}

/**
 * Queues the next `limit` people of the oldest announcement that is sending, in one transaction
 * with its progress. A second worker skips the locked row. Never more than what is left of the daily
 * limit: at the limit it queues nobody and the send stays `sending`, carrying on by itself as the
 * 24 hours free up. A batch that finds nobody after the people it queued finishes the send.
 * Someone whose preferences changed since the approval is skipped here, and again at send time.
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
      if (!row)
        return {
          announcementId: null,
          queued: 0,
          finished: false,
          paused: false,
        };
      // Two batches (two announcements, two workers) count and queue one after the other, so
      // together they never pass the limit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${DAILY_LIMIT_LOCK})`);
      const { remaining } = await announcementDailyUse(tx, input.now);
      const take = Math.min(Math.max(1, Math.floor(input.limit)), remaining);
      // One more than it may take, to know whether anyone is left after them.
      const found = await tx.execute<{ id: string; email: string }>(
        sql`SELECT u.id, u.email FROM users u
          LEFT JOIN mail_preferences mp ON mp.user_id = u.id
          WHERE ${audienceWhere(row.audience as AnnouncementAudience, row.kind as AnnouncementKind)}
            AND u.created_at <= ${(row.cutoff ?? input.now).toISOString()}::timestamptz
            ${row.cursorUserId ? sql`AND u.id > ${row.cursorUserId}::uuid` : sql``}
          ORDER BY u.id
          LIMIT ${take + 1}`,
      );
      const finished = found.rows.length <= take;
      const next = found.rows.slice(0, take);
      if (next.length === 0 && !finished)
        return {
          announcementId: row.id,
          queued: 0,
          finished: false,
          paused: true,
        };
      const data = announcementMailData(row);
      let queued = 0;
      for (const person of next) {
        // An address that can't be mailed is passed over; it never holds back the rest.
        const to = normaliseEmail(person.email);
        if (!to) continue;
        await enqueueMail(tx, sealing, {
          type: announcementMailType(row.kind),
          to,
          userId: person.id,
          data,
          dedupeKey: `announcement:${row.id}:${person.id}`,
          now: input.now,
        });
        queued += 1;
      }
      const last = next[next.length - 1];
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
      return { announcementId: row.id, queued, finished, paused: false };
    }),
  );
}
