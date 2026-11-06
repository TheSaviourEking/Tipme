import {
  changelogState,
  hasUnapprovedEdit,
  userTextProblems,
  type ChangelogAudience,
  type OpsChangelogEdit,
  type OpsChangelogEntry,
  type OpsChangelogList,
  type OpsChangelogRow,
  type OpsChangelogView,
} from '@tipme/contracts';
import { and, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { approvalRequests, changelogEntries, users } from '../schema.js';
import { recordAudit } from './audit.js';
import { maskEmail } from './email-address.js';
import { guarded, OperationError } from './errors.js';
import {
  requestSeriousAction,
  type SeriousActionDefinition,
  type SeriousActionOutcome,
  type SeriousActionServices,
} from './serious-actions.js';
import { checkedReason, withAuditChange } from './staff.js';

/*
 * The changelog in admin (changelog plan, 5 Nov 2026, Design §1 and §4, Task 4.1). Staff edit the
 * working copy; only `approveChangelogEntry` ever writes the published copy users read. Every write
 * is audited with the entry's number and revision, never its text.
 */

export const CHANGELOG_PUBLISH_ACTION = 'changelog.publish';
const PAGE_SIZE = 50;
const SUBJECT = 'changelog_entry';

type EntryRow = typeof changelogEntries.$inferSelect;

const iso = (date: Date | null) => date?.toISOString() ?? null;
const audienceOf = (value: string | null) => value as ChangelogAudience | null;

function toRow(
  row: EntryRow,
  waitingRequestId: string | null,
): OpsChangelogRow {
  const audience = row.audience as ChangelogAudience;
  return {
    number: row.prNumber,
    title: row.prTitle,
    staffText: row.staffText,
    state: changelogState({
      audience,
      publishedAudience: audienceOf(row.publishedAudience),
      publishedRevision: row.publishedRevision,
      liveAt: iso(row.liveAt),
      withdrawnAt: iso(row.withdrawnAt),
    }),
    unapprovedEdit: hasUnapprovedEdit(row),
    audience,
    publishedAudience: audienceOf(row.publishedAudience),
    mergedAt: row.mergedAt.toISOString(),
    stagingAt: iso(row.stagingAt),
    liveAt: iso(row.liveAt),
    waitingRequestId,
  };
}

/** The newest waiting approval request for each entry, if any. */
async function waitingRequests(
  db: Database | Tx,
  numbers: number[],
  now: Date,
): Promise<Map<number, string>> {
  const waiting = new Map<number, string>();
  if (numbers.length === 0) return waiting;
  const number = sql<number>`(${approvalRequests.payload}->>'number')::int`;
  const rows = await db
    .select({ id: approvalRequests.id, number })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.action, CHANGELOG_PUBLISH_ACTION),
        eq(approvalRequests.status, 'pending'),
        gt(approvalRequests.expiresAt, now),
        inArray(number, numbers),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt));
  for (const row of rows)
    if (!waiting.has(row.number)) waiting.set(row.number, row.id);
  return waiting;
}

async function toEntry(
  db: Database | Tx,
  row: EntryRow,
  now: Date,
): Promise<OpsChangelogEntry> {
  const waiting = await waitingRequests(db, [row.prNumber], now);
  let approvedBy: string | null = null;
  if (row.approvedBy) {
    const [approver] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, row.approvedBy));
    approvedBy = approver?.email ? maskEmail(approver.email) : null;
  }
  return {
    ...toRow(row, waiting.get(row.prNumber) ?? null),
    userText: row.userText,
    publishedText: row.publishedText,
    revision: row.revision,
    publishedRevision: row.publishedRevision,
    approvedAt: iso(row.approvedAt),
    approvedBy,
    withdrawnAt: iso(row.withdrawnAt),
    withdrawnReason: row.withdrawnReason,
    problems: row.userText ? userTextProblems(row.userText) : [],
  };
}

async function entryOrThrow(
  db: Database | Tx,
  number: number,
  lock = false,
): Promise<EntryRow> {
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new OperationError('CHANGELOG_NOT_FOUND');
  const query = db
    .select()
    .from(changelogEntries)
    .where(eq(changelogEntries.prNumber, number));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new OperationError('CHANGELOG_NOT_FOUND');
  return row;
}

/** Which entries each filter holds (Design §5). */
function viewFilter(view: OpsChangelogView): SQL | undefined {
  const e = changelogEntries;
  switch (view) {
    case 'drafts':
      // State draft, or an approved copy with an edit not yet approved.
      return sql`((${e.withdrawnAt} IS NULL AND ${e.publishedRevision} IS NULL AND ${e.audience} <> 'staff')
        OR (${e.publishedRevision} IS NOT NULL AND ${e.revision} <> ${e.publishedRevision}))`;
    case 'users':
      // What users can read now: a withdrawn entry has left this view (it stays in All).
      return sql`(${e.withdrawnAt} IS NULL AND ${e.publishedAudience} IN ('everyone', 'pro', 'early_access'))`;
    case 'staff':
      return sql`(${e.withdrawnAt} IS NULL AND ((${e.publishedRevision} IS NULL AND ${e.audience} = 'staff')
        OR ${e.publishedAudience} = 'staff'))`;
    default:
      return undefined;
  }
}

/** Every merged PR, newest merged first, 50 at a time. `before` is the last number of the page before. */
export function listChangelog(
  db: Database,
  q: { view: OpsChangelogView; before?: number; now?: Date },
): Promise<OpsChangelogList> {
  return guarded(async () => {
    const e = changelogEntries;
    let after: SQL | undefined;
    if (q.before !== undefined) {
      const [cursor] = Number.isSafeInteger(q.before)
        ? await db
            .select({ mergedAt: e.mergedAt })
            .from(e)
            .where(eq(e.prNumber, q.before))
        : [];
      if (!cursor) return { rows: [], nextBefore: null };
      after = sql`(${e.mergedAt}, ${e.prNumber}) < (${cursor.mergedAt.toISOString()}::timestamptz, ${q.before})`;
    }
    const found = await db
      .select()
      .from(e)
      .where(and(viewFilter(q.view), after))
      .orderBy(desc(e.mergedAt), desc(e.prNumber))
      .limit(PAGE_SIZE + 1);
    const page = found.slice(0, PAGE_SIZE);
    const waiting = await waitingRequests(
      db,
      page.map((row) => row.prNumber),
      q.now ?? new Date(),
    );
    return {
      rows: page.map((row) => toRow(row, waiting.get(row.prNumber) ?? null)),
      nextBefore:
        found.length > PAGE_SIZE ? page[page.length - 1]!.prNumber : null,
    };
  });
}

export function readChangelogEntry(
  db: Database,
  number: number,
  now?: Date,
): Promise<OpsChangelogEntry> {
  return guarded(async () =>
    toEntry(db, await entryOrThrow(db, number), now ?? new Date()),
  );
}

/**
 * Edits the working copy, refusing if someone else moved it since the editor read it. A change to the
 * user text or "who sees it" bumps the revision, so any approval asked for before goes stale; the
 * staff text doesn't. Users keep reading the published copy until a new approval.
 */
export function editChangelogEntry(
  db: Database,
  input: {
    staffUserId: string;
    number: number;
    patch: OpsChangelogEdit;
    now?: Date;
  },
): Promise<OpsChangelogEntry> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      const row = await entryOrThrow(tx, input.number, true);
      const { patch } = input;
      if (row.revision !== patch.revision)
        throw new OperationError('CHANGELOG_EDITED_ELSEWHERE');
      const userText =
        patch.userText === undefined ? row.userText : patch.userText;
      let audience = (patch.audience ?? row.audience) as ChangelogAudience;
      if (userText === null) audience = 'staff';
      else if (audience === 'staff') {
        // Asked for in so many words: a user text that no user reads is a contradiction.
        if (patch.audience === 'staff')
          throw new OperationError('INVALID_INPUT');
        audience = 'everyone';
      }
      const staffText = patch.staffText ?? row.staffText;
      const userChanged =
        userText !== row.userText || audience !== row.audience;
      const staffChanged = staffText !== row.staffText;
      if (!userChanged && !staffChanged) return toEntry(tx, row, now);
      const revision = userChanged ? row.revision + 1 : row.revision;
      const [updated] = await tx
        .update(changelogEntries)
        .set({ staffText, userText, audience, revision, updatedAt: now })
        .where(eq(changelogEntries.prNumber, row.prNumber))
        .returning();
      const fields = [
        ...(staffChanged ? ['staffText'] : []),
        ...(userText !== row.userText ? ['userText'] : []),
        ...(audience !== row.audience ? ['audience'] : []),
      ];
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'changelog.edited',
        permission: 'changelog.edit',
        subjectType: SUBJECT,
        subjectId: String(row.prNumber),
        reason: withAuditChange('Edited a changelog entry', {
          number: row.prNumber,
          revision,
          fields,
        }),
        now,
      });
      return toEntry(tx, updated!, now);
    }),
  );
}

/**
 * The one approval: copies the working copy to the published copy, but only at the revision the
 * approver read, and only a text users may read. Approving a withdrawn entry (after an edit) shows it
 * again, and the audit says so. A Tx is a savepoint inside the caller's transaction (the approvals flow).
 */
export function approveChangelogEntry(
  db: Database | Tx,
  input: {
    number: number;
    revision: number;
    approverId: string;
    reason: string;
    /** Who asked, when it came through Approvals. */
    askedBy?: string;
    now?: Date;
  },
): Promise<OpsChangelogEntry> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    return db.transaction(async (tx) => {
      const row = await entryOrThrow(tx, input.number, true);
      if (row.revision !== input.revision)
        throw new OperationError('CHANGELOG_EDITED_ELSEWHERE');
      // Already the published copy; and a staff entry never published is recorded with no approval.
      if (
        row.revision === row.publishedRevision ||
        (row.userText === null && row.publishedRevision === null)
      )
        throw new OperationError('INVALID_INPUT');
      const problems = row.userText ? userTextProblems(row.userText) : [];
      if (problems.length > 0)
        // Fixed problem names only: the API hands them to the screen.
        throw new OperationError(
          'CHANGELOG_TEXT_NOT_ALLOWED',
          problems.join(','),
        );
      const restored = row.withdrawnAt !== null;
      const [updated] = await tx
        .update(changelogEntries)
        .set({
          publishedText: row.userText,
          publishedAudience: row.audience,
          publishedRevision: row.revision,
          approvedAt: now,
          approvedBy: input.approverId,
          withdrawnAt: null,
          withdrawnBy: null,
          withdrawnReason: null,
          updatedAt: now,
        })
        .where(eq(changelogEntries.prNumber, row.prNumber))
        .returning();
      await recordAudit(tx, {
        staffUserId: input.approverId,
        action: 'changelog.approved',
        permission: 'changelog.publish',
        subjectType: SUBJECT,
        subjectId: String(row.prNumber),
        reason: withAuditChange(reason, {
          number: row.prNumber,
          revision: row.revision,
          audience: row.audience,
          restored,
          ...(input.askedBy ? { askedBy: input.askedBy } : {}),
        }),
        now,
      });
      return toEntry(tx, updated!, now);
    });
  });
}

/**
 * Hides an entry from users at once, with a reason. Never deletes and is never undone in place: to
 * show it again, staff edit it and approve it again. Withdrawing a withdrawn entry changes nothing.
 */
export function withdrawChangelogEntry(
  db: Database,
  input: { staffUserId: string; number: number; reason: string; now?: Date },
): Promise<OpsChangelogEntry> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    const reason = checkedReason(input.reason);
    return db.transaction(async (tx) => {
      const row = await entryOrThrow(tx, input.number, true);
      if (row.withdrawnAt) return toEntry(tx, row, now);
      const [updated] = await tx
        .update(changelogEntries)
        .set({
          withdrawnAt: now,
          withdrawnBy: input.staffUserId,
          withdrawnReason: reason,
          updatedAt: now,
        })
        .where(eq(changelogEntries.prNumber, row.prNumber))
        .returning();
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'changelog.withdrawn',
        permission: 'changelog.edit',
        subjectType: SUBJECT,
        subjectId: String(row.prNumber),
        reason: withAuditChange(reason, {
          number: row.prNumber,
          revision: row.revision,
        }),
        now,
      });
      return toEntry(tx, updated!, now);
    });
  });
}

/* The approvals flow (Design §4, Task 4.2) */

export interface ChangelogPublishPayload {
  number: number;
  revision: number;
}

const AUDIENCE_WORDS: Record<Exclude<ChangelogAudience, 'staff'>, string> = {
  everyone: 'everyone',
  pro: 'Pro',
  early_access: 'early access',
};

const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** The checks approval repeats: the entry at that revision, with a text users may read. */
async function publishable(
  tx: Database | Tx,
  payload: ChangelogPublishPayload,
): Promise<EntryRow> {
  if (!positiveInt(payload?.number) || !positiveInt(payload?.revision))
    throw new OperationError('INVALID_INPUT');
  const row = await entryOrThrow(tx, payload.number);
  if (row.revision !== payload.revision)
    throw new OperationError('CHANGELOG_EDITED_ELSEWHERE');
  if (row.userText === null || row.revision === row.publishedRevision)
    throw new OperationError('INVALID_INPUT');
  const problems = userTextProblems(row.userText);
  if (problems.length > 0)
    throw new OperationError('CHANGELOG_TEXT_NOT_ALLOWED', problems.join(','));
  return row;
}

/**
 * `changelog.publish`: an editor asks a publisher to show users an entry. Asked for with
 * `changelog.edit`, decided with `changelog.publish`, so an editor can never run it alone. The full
 * text (at most 280 characters, never private) is in the summary the approver reads.
 */
export const changelogPublishAction: SeriousActionDefinition<ChangelogPublishPayload> =
  {
    name: CHANGELOG_PUBLISH_ACTION,
    permission: 'changelog.publish',
    askPermission: 'changelog.edit',
    validate: async (tx, payload) => {
      await publishable(tx, payload);
    },
    target: ({ number }) => `changelog:${number}`,
    // Any edit, direct approval or withdrawal while it waits makes the request stale.
    current: async (tx, { number }) => {
      const [row] = await tx
        .select({
          revision: changelogEntries.revision,
          publishedRevision: changelogEntries.publishedRevision,
          withdrawnAt: changelogEntries.withdrawnAt,
        })
        .from(changelogEntries)
        .where(eq(changelogEntries.prNumber, number));
      return row
        ? {
            revision: row.revision,
            publishedRevision: row.publishedRevision,
            withdrawnAt: iso(row.withdrawnAt),
          }
        : null;
    },
    describe: async (tx, payload) => {
      const row = await publishable(tx, payload);
      const audience = row.audience as Exclude<ChangelogAudience, 'staff'>;
      return `Show users this What’s new entry (#${row.prNumber}, ${AUDIENCE_WORDS[audience]}): “${row.userText}”`;
    },
    run: (tx, payload, context) =>
      approveChangelogEntry(tx, {
        number: payload.number,
        revision: payload.revision,
        approverId: context.approverId ?? context.actorId,
        reason: context.reason,
        askedBy: context.actorId,
        now: context.now,
      }),
  };

/** An editor asks for the revision they read to be shown to users (POST …/ask). */
export function askToPublishChangelogEntry(
  db: Database,
  input: {
    actorId: string;
    grantId: string;
    number: number;
    revision: number;
    reason: string;
    services: SeriousActionServices;
    now?: Date;
  },
): Promise<SeriousActionOutcome> {
  return requestSeriousAction(db, {
    name: CHANGELOG_PUBLISH_ACTION,
    payload: {
      number: input.number,
      revision: input.revision,
    } satisfies ChangelogPublishPayload,
    actorId: input.actorId,
    grantId: input.grantId,
    reason: input.reason,
    services: input.services,
    ...(input.now ? { now: input.now } : {}),
  });
}
