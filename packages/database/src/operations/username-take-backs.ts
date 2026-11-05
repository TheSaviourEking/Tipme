import {
  TAKE_BACK_CATEGORIES,
  TAKE_BACK_CATEGORY_WORDS,
  TAKE_BACK_FREE_CHANGE_MS,
  TAKE_BACK_WHY,
  type MyProfile,
  type OpsTakeBack,
  type OpsTakeBackFacts,
  type OpsTakeBackPending,
  type PagePlan,
  type PageState,
  type TakeBackCategory,
  type TakeBackKind,
  type TakeBackNoticedVia,
  type TakeBackOutcome,
  type TakeBackState,
} from '@tipme/contracts';
import {
  isReservedHandle,
  lagosDateWords,
  reservationKey,
  takeBackDueAt,
} from '@tipme/domain';
import { randomInt } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, Tx } from '../client.js';
import {
  approvalRequests,
  handleAliases,
  handleReservations,
  handleTakeBacks,
  mailMessages,
  payouts,
  profiles,
  users,
} from '../schema.js';
import { mailOwner } from './account-mail.js';
import { recordAudit } from './audit.js';
import { balanceIn } from './balance.js';
import { maskEmail } from './email-address.js';
import { guarded, OperationError, sqlStateOf } from './errors.js';
import { newId } from './ids.js';
import type { MailSealing } from './mail-queue.js';
import { enqueueOutbox } from './outbox.js';
import { isTaken } from './profiles.js';
import {
  requestSeriousAction,
  type SeriousActionDefinition,
  type SeriousActionServices,
} from './serious-actions.js';
import { checkedReason, withAuditChange } from './staff.js';

/*
 * Taking a username back from a page (username reservation spec, sections 5.3 to 5.10, and the
 * owner's answers of 3 Nov 2026 in section 12). Asking is the serious action `username.take_back`;
 * approval creates the row and queues the notice. The clock starts only at a sent email or a seen
 * banner, and with neither the take-back goes ahead after 14 days. One completion,
 * `completeTakeBack`, serves the user's choice, the deadline, page deletion and the never-reached
 * path. Lock order everywhere: the staff-admin lock (where the caller already takes it), then the
 * profile row, then the take-back row.
 */

const PERMISSION = 'usernames.manage';
export const TAKE_BACK_ACTION = 'username.take_back';
/** No-notice take-backs are PR 3; until then the shortest notice is one day. */
const MIN_NOTICE_DAYS = 1;
const OPEN_STATES = ['approved', 'noticed', 'due'] as const;
const LIST_LIMIT = 100;

export interface TakeBackPayload {
  profileId: string;
  name: string;
  kind: TakeBackKind;
  category: TakeBackCategory;
  noticeDays: number;
}

type TakeBackRow = typeof handleTakeBacks.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page row, locked: the take-back changes what the page is called. */
async function lockProfile(tx: Tx, profileId: string) {
  const [row] = await tx
    .select()
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .for('update');
  return row ?? null;
}

async function holdsAs(
  db: Database | Tx,
  profileId: string,
  name: string,
): Promise<TakeBackKind | null> {
  const [page] = await db
    .select({ handleLower: profiles.handleLower })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  if (!page) return null;
  if (page.handleLower === name) return 'current';
  const [old] = await db
    .select({ name: handleAliases.handleLower })
    .from(handleAliases)
    .where(
      and(
        eq(handleAliases.handleLower, name),
        eq(handleAliases.profileId, profileId),
      ),
    );
  return old ? 'old' : null;
}

async function openTakeBackRow(
  db: Database | Tx,
  name: string,
): Promise<TakeBackRow | null> {
  const [row] = await db
    .select()
    .from(handleTakeBacks)
    .where(
      and(
        eq(handleTakeBacks.handleLower, name),
        inArray(handleTakeBacks.state, [...OPEN_STATES]),
      ),
    );
  return row ?? null;
}

const noticeFits = (category: string, days: unknown) =>
  typeof days === 'number' &&
  Number.isInteger(days) &&
  (category === 'ordinary'
    ? days >= 7 && days <= 30
    : days >= MIN_NOTICE_DAYS && days <= 7);

/** Every refusal the action can give, in the order the spec lists them. */
async function checkTakeBack(tx: Tx, payload: TakeBackPayload): Promise<void> {
  const { name, profileId, kind, category, noticeDays } = payload;
  if (typeof name !== 'string') throw new OperationError('INVALID_INPUT');
  if (isReservedHandle(name)) throw new OperationError('USERNAME_BUILT_IN');
  if (
    reservationKey(name) !== name ||
    !TAKE_BACK_CATEGORIES.includes(category) ||
    (kind !== 'current' && kind !== 'old') ||
    typeof profileId !== 'string' ||
    !UUID.test(profileId)
  )
    throw new OperationError('INVALID_INPUT');
  const [page] = await tx
    .select({
      pageState: profiles.pageState,
      rehearsalRunId: profiles.rehearsalRunId,
    })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  if (!page || page.pageState === 'deleted')
    throw new OperationError('NO_PAGE');
  // A release-check page is a test copy: nothing about it is anyone's username.
  if (page.rehearsalRunId) throw new OperationError('INVALID_INPUT');
  if ((await holdsAs(tx, profileId, name)) !== kind)
    throw new OperationError('USERNAME_HELD_BY_PAGE');
  if (await openTakeBackRow(tx, name))
    throw new OperationError('TAKE_BACK_OPEN');
  if (!noticeFits(category, noticeDays))
    throw new OperationError('INVALID_INPUT');
}

const noticeWords = (days: number) =>
  days === 0 ? 'no notice' : `${days} ${days === 1 ? 'day’s' : 'days’'} notice`;

/**
 * Registered directly, not through `acting`: its check must not dry-run the notice email, and
 * approval's checks re-run under the profile lock inside `run`.
 */
export const takeBackAction: SeriousActionDefinition<TakeBackPayload> = {
  name: TAKE_BACK_ACTION,
  permission: PERMISSION,
  validate: (tx, payload) => checkTakeBack(tx, payload),
  subjects: async ({ profileId }, db) => {
    if (typeof profileId !== 'string' || !UUID.test(profileId)) return [];
    const [page] = await db
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.id, profileId));
    return page?.userId ? [page.userId] : [];
  },
  target: ({ profileId, name }) => `${profileId}:${name}`,
  // A rename while it waits changes what the name is to the page, so approval goes stale.
  current: async (tx, { profileId, name }) => ({
    profileId,
    kind: await holdsAs(tx, profileId, name),
  }),
  describe: async (_tx, { name, category, noticeDays }) =>
    `Take @${name} back from its page: ${TAKE_BACK_CATEGORY_WORDS[
      category
    ].toLowerCase()}, ${noticeWords(noticeDays)}`,
  run: async (tx, payload, context) => {
    if (!context.services) throw new OperationError('INVALID_INPUT');
    await lockProfile(tx, payload.profileId);
    await checkTakeBack(tx, payload);
    try {
      return await startTakeBack(tx, payload, {
        actorId: context.actorId,
        approverId: context.approverId,
        approvalRequestId: context.requestId ?? null,
        reason: context.reason,
        now: context.now,
        sealing: context.services.sealing,
      });
    } catch (error) {
      // The profile lock serialises take-backs of a page's names, so this is only a backstop.
      if (sqlStateOf(error) === '23505')
        throw new OperationError('TAKE_BACK_OPEN');
      throw error;
    }
  },
};

/**
 * Asks to take `name` back from the page. The server decides whether it is the page's current or
 * an old username; one it doesn't hold at all is refused by the action's own check.
 */
export function requestTakeBack(
  db: Database,
  input: {
    actorId: string;
    grantId: string;
    name: string;
    profileId: string;
    category: TakeBackCategory;
    noticeDays: number;
    reason: string;
    services: SeriousActionServices;
    now?: Date;
  },
) {
  return guarded(async () => {
    const raw = input.name.trim();
    if (isReservedHandle(raw)) throw new OperationError('USERNAME_BUILT_IN');
    const name = reservationKey(raw);
    if (!name) throw new OperationError('INVALID_INPUT');
    const kind = UUID.test(input.profileId)
      ? ((await holdsAs(db, input.profileId, name)) ?? 'current')
      : 'current';
    return requestSeriousAction(db, {
      name: TAKE_BACK_ACTION,
      payload: {
        profileId: input.profileId,
        name,
        kind,
        category: input.category,
        noticeDays: input.noticeDays,
      } satisfies TakeBackPayload,
      actorId: input.actorId,
      grantId: input.grantId,
      reason: input.reason,
      services: input.services,
      ...(input.now ? { now: input.now } : {}),
    });
  });
}

/** The approved take-back: the row, the queued notice, the audit entry. The caller holds the profile lock. */
export async function startTakeBack(
  tx: Tx,
  payload: TakeBackPayload,
  ctx: {
    actorId: string;
    approverId: string | null;
    approvalRequestId: string | null;
    reason: string;
    now: Date;
    sealing: MailSealing;
  },
): Promise<{ takeBackId: string; revalidateHandles: string[] }> {
  const id = newId();
  const [page] = await tx
    .select({ handle: profiles.handle })
    .from(profiles)
    .where(eq(profiles.id, payload.profileId));
  if (!page) throw new OperationError('NO_PAGE');
  await tx.insert(handleTakeBacks).values({
    id,
    approvalRequestId: ctx.approvalRequestId,
    profileId: payload.profileId,
    handleLower: payload.name,
    kind: payload.kind,
    category: payload.category,
    noticeDays: payload.noticeDays,
    reason: ctx.reason,
    state: 'approved',
    requestedBy: ctx.actorId,
    approvedBy: ctx.approverId,
    approvedAt: ctx.now,
  });
  // The earliest the deadline can be: noticing happens at or after approval.
  const queued = await mailOwner(tx, ctx.sealing, {
    profileId: payload.profileId,
    type: 'username_take_back_notice',
    data: {
      kind: payload.kind,
      old: payload.name,
      current: page.handle,
      why: TAKE_BACK_WHY[payload.category],
      dueDate: lagosDateWords(takeBackDueAt(ctx.now, payload.noticeDays)),
    },
    dedupeKey: `username_take_back_notice.${id}`,
    now: ctx.now,
  });
  if (queued)
    await tx
      .update(handleTakeBacks)
      .set({ noticeMailId: queued.id })
      .where(eq(handleTakeBacks.id, id));
  await recordAudit(tx, {
    staffUserId: ctx.actorId,
    action: 'username.take_back_started',
    permission: PERMISSION,
    subjectType: 'username',
    subjectId: payload.name,
    reason: withAuditChange(ctx.reason, {
      takeBackId: id,
      requestedBy: ctx.actorId,
      approvedBy: ctx.approverId,
      category: payload.category,
      noticeDays: payload.noticeDays,
      kind: payload.kind,
      profileId: payload.profileId,
    }),
    now: ctx.now,
  });
  // Nothing public changes until it completes (the no-notice path, PR 3, fills this).
  return { takeBackId: id, revalidateHandles: [] };
}

/**
 * Cancels an open take-back, instantly (any holder of `usernames.manage`, with a reason). A notice
 * still queued is stopped; someone who may have read it gets the cancelled email.
 */
export function cancelTakeBack(
  db: Database,
  input: {
    staffId: string;
    takeBackId: string;
    reason: string;
    sealing: MailSealing;
    now?: Date;
  },
): Promise<OpsTakeBack> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    if (!UUID.test(input.takeBackId))
      throw new OperationError('TAKE_BACK_NOT_FOUND');
    const reason = checkedReason(input.reason);
    await db.transaction(async (tx) => {
      const [first] = await tx
        .select({ profileId: handleTakeBacks.profileId })
        .from(handleTakeBacks)
        .where(eq(handleTakeBacks.id, input.takeBackId));
      if (!first) throw new OperationError('TAKE_BACK_NOT_FOUND');
      await lockProfile(tx, first.profileId);
      const row = await lockTakeBack(tx, input.takeBackId);
      if (!row) throw new OperationError('TAKE_BACK_NOT_FOUND');
      if (!isOpen(row.state)) throw new OperationError('TAKE_BACK_CLOSED');
      await tx
        .update(handleTakeBacks)
        .set({
          state: 'cancelled',
          cancelledAt: now,
          cancelledBy: input.staffId,
          cancelReason: reason,
        })
        .where(eq(handleTakeBacks.id, row.id));
      // A notice or reminder not yet picked up never goes out.
      const stopped = await tx
        .update(mailMessages)
        .set({ expiresAt: now })
        .where(
          and(
            eq(mailMessages.status, 'queued'),
            inArray(mailMessages.dedupeKey, [
              `username_take_back_notice.${row.id}`,
              `username_take_back_reminder.${row.id}`,
            ]),
          ),
        )
        .returning({ id: mailMessages.id });
      const noticeStopped = stopped.some((m) => m.id === row.noticeMailId);
      const mayHaveRead =
        row.noticedAt !== null ||
        row.bannerSeenAt !== null ||
        (row.noticeMailId !== null && !noticeStopped);
      if (mayHaveRead)
        await mailOwner(tx, input.sealing, {
          profileId: row.profileId,
          type: 'username_take_back_cancelled',
          data: { old: row.handleLower },
          dedupeKey: `username_take_back_cancelled.${row.id}`,
          now,
        });
      await recordAudit(tx, {
        staffUserId: input.staffId,
        action: 'username.take_back_cancelled',
        permission: PERMISSION,
        subjectType: 'username',
        subjectId: row.handleLower,
        reason: withAuditChange(reason, {
          takeBackId: row.id,
          stateBefore: row.state,
        }),
        now,
      });
    });
    return (await takeBackView(db, input.takeBackId))!;
  });
}

const isOpen = (state: string) =>
  (OPEN_STATES as readonly string[]).includes(state);

async function lockTakeBack(tx: Tx, id: string): Promise<TakeBackRow | null> {
  const [row] = await tx
    .select()
    .from(handleTakeBacks)
    .where(eq(handleTakeBacks.id, id))
    .for('update');
  return row ?? null;
}

const HANDLE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const randomSuffix = () =>
  Array.from(
    { length: 6 },
    () => HANDLE_CHARS[randomInt(HANDLE_CHARS.length)],
  ).join('');

/**
 * The username TipMe gives a page whose deadline passed: `page_` and six letters or digits. Never
 * built-in, reserved or taken; after 10 tries it gives up, and the take-back stays due for the next run.
 */
export async function generatedHandle(
  tx: Tx,
  random: () => string = randomSuffix,
  now: Date = new Date(),
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const handle = `page_${random()}`;
    if (!/^page_[a-z0-9]{6}$/.test(handle)) continue;
    if (isReservedHandle(handle)) continue;
    if (await isTaken(tx, handle, now)) continue;
    return handle;
  }
  throw new OperationError('HANDLE_TAKEN', 'no free generated username');
}

/**
 * The one completion: the user's choice, the deadline, page deletion, the never-reached path and
 * (PR 3) no notice. The caller holds the profile lock. In order: move the page off the name, reserve
 * the name, close the row, queue the done email, audit, and post the staff alert. It never writes an
 * alias for the taken name.
 */
export async function completeTakeBack(
  tx: Tx,
  input: {
    takeBackId: string;
    outcome: TakeBackOutcome;
    noticedVia?: TakeBackNoticedVia;
    chosenHandle?: string;
    withoutNotice?: boolean;
    sealing: MailSealing;
    now: Date;
    actorUserId: string | null;
  },
): Promise<{ old: string; current: string; newHandle: string | null }> {
  const { now } = input;
  const row = await lockTakeBack(tx, input.takeBackId);
  if (!row) throw new OperationError('TAKE_BACK_NOT_FOUND');
  if (!isOpen(row.state)) throw new OperationError('TAKE_BACK_CLOSED');
  const name = row.handleLower;
  let newHandle: string | null = null;
  // 1. The page moves off the name.
  if (input.outcome === 'user_chose' || input.outcome === 'assigned') {
    if (row.kind !== 'current') throw new OperationError('INVALID_INPUT');
    newHandle =
      input.outcome === 'user_chose'
        ? (input.chosenHandle ?? null)
        : await generatedHandle(tx, undefined, now);
    if (!newHandle) throw new OperationError('INVALID_INPUT');
    await tx
      .update(profiles)
      .set({ handle: newHandle, handleLower: newHandle })
      .where(
        and(eq(profiles.id, row.profileId), eq(profiles.handleLower, name)),
      );
  } else if (input.outcome === 'old_removed') {
    await tx
      .delete(handleAliases)
      .where(
        and(
          eq(handleAliases.handleLower, name),
          eq(handleAliases.profileId, row.profileId),
        ),
      );
  }
  // 2. The name is reserved, so nobody else can take it (the trigger allows it now nobody holds it).
  await tx.insert(handleReservations).values({
    id: newId(),
    handleLower: name,
    source: 'take_back',
    takeBackId: row.id,
    reason: 'Taken back',
    reservedBy: null,
    reservedAt: now,
  });
  // 3. The row closes.
  const freeChange =
    input.outcome === 'assigned'
      ? new Date(now.getTime() + TAKE_BACK_FREE_CHANGE_MS)
      : null;
  const noticedVia = row.noticedVia ?? input.noticedVia ?? null;
  await tx
    .update(handleTakeBacks)
    .set({
      state: 'done',
      outcome: input.outcome,
      doneAt: now,
      newHandle,
      noticedVia,
      ...(freeChange ? { freeChangeUntil: freeChange } : {}),
    })
    .where(eq(handleTakeBacks.id, row.id));
  const [page] = await tx
    .select({ handle: profiles.handle })
    .from(profiles)
    .where(eq(profiles.id, row.profileId));
  const current = page?.handle ?? newHandle ?? name;
  // 4. The done email (a deleted page gets none).
  if (input.outcome !== 'page_deleted') {
    const variant =
      input.outcome === 'user_chose'
        ? 'user_chose'
        : input.outcome === 'old_removed'
          ? 'old'
          : input.withoutNotice
            ? 'without_notice'
            : noticedVia === 'unreached'
              ? 'unreached'
              : 'assigned';
    await mailOwner(tx, input.sealing, {
      profileId: row.profileId,
      type: 'username_take_back_done',
      data: {
        variant,
        old: name,
        new: newHandle,
        current,
        why: TAKE_BACK_WHY[row.category as TakeBackCategory],
        noticeDate: row.noticedAt ? lagosDateWords(row.noticedAt) : null,
        freeChangeDate: freeChange ? lagosDateWords(freeChange) : null,
      },
      dedupeKey: `username_take_back_done.${row.id}`,
      now,
    });
  }
  // 5. Audit and the staff alert.
  await recordAudit(tx, {
    staffUserId: input.actorUserId,
    action: 'username.take_back_done',
    permission: PERMISSION,
    subjectType: 'username',
    subjectId: name,
    reason: withAuditChange('Take-back completed', {
      takeBackId: row.id,
      outcome: input.outcome,
      newHandle,
      noticedVia,
    }),
    now,
  });
  await enqueueOutbox(tx, {
    eventType: 'username.take_back_done',
    aggregateId: row.id,
    payload: {
      takeBackId: row.id,
      action: TAKE_BACK_ACTION,
      requestedBy: row.requestedBy,
    },
  });
  return { old: name, current, newHandle };
}

/** Yes or no only: what staff weigh before asking. Never an amount or an address. */
export async function takeBackFacts(
  db: Database | Tx,
  profileId: string,
): Promise<Omit<OpsTakeBackFacts, 'liveCheckoutListed'>> {
  const [page] = await db
    .select({
      plan: profiles.plan,
      pageState: profiles.pageState,
      status: profiles.status,
      emailVerifiedAt: users.emailVerifiedAt,
      email: users.email,
      deletedAt: users.deletedAt,
    })
    .from(profiles)
    .leftJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.id, profileId));
  if (!page) throw new OperationError('NO_PAGE');
  const balance = await balanceIn(db, profileId);
  const [inFlight] = await db
    .select({ id: payouts.id })
    .from(payouts)
    .where(
      and(
        eq(payouts.profileId, profileId),
        inArray(payouts.status, ['REQUESTED', 'PROCESSING']),
      ),
    )
    .limit(1);
  return {
    plan: page.plan as PagePlan,
    pageState: page.pageState as PageState,
    suspended: page.status === 'suspended',
    hasBalance: balance.availableMinor > 0n || balance.confirmingMinor > 0n,
    withdrawalInFlight: inFlight !== undefined,
    verifiedEmail: Boolean(
      page.email && page.emailVerifiedAt && !page.deletedAt,
    ),
  };
}

const requester = alias(users, 'take_back_requester');
const approver = alias(users, 'take_back_approver');

const iso = (at: Date | null) => at?.toISOString() ?? null;
const masked = (email: string | null) =>
  email ? maskEmail(email) : 'A staff member';

async function takeBackViews(
  db: Database | Tx,
  where: ReturnType<typeof eq> | undefined,
  limit: number,
): Promise<OpsTakeBack[]> {
  const rows = await db
    .select({
      row: handleTakeBacks,
      pageHandle: profiles.handle,
      plan: profiles.plan,
      requestedBy: requester.email,
      approvedBy: approver.email,
    })
    .from(handleTakeBacks)
    .innerJoin(profiles, eq(profiles.id, handleTakeBacks.profileId))
    .leftJoin(requester, eq(requester.id, handleTakeBacks.requestedBy))
    .leftJoin(approver, eq(approver.id, handleTakeBacks.approvedBy))
    .where(where)
    // Open ones first, then the newest.
    .orderBy(
      sql`CASE WHEN ${handleTakeBacks.state} IN ('approved', 'noticed', 'due') THEN 0 ELSE 1 END`,
      desc(handleTakeBacks.approvedAt),
      desc(handleTakeBacks.id),
    )
    .limit(limit);
  return rows.map(({ row, pageHandle, plan, requestedBy, approvedBy }) => ({
    id: row.id,
    name: row.handleLower,
    profileId: row.profileId,
    pageHandle,
    plan: plan as PagePlan,
    kind: row.kind as TakeBackKind,
    category: row.category as TakeBackCategory,
    noticeDays: row.noticeDays,
    state: row.state as TakeBackState,
    requestedBy: masked(requestedBy),
    approvedBy: row.approvedBy ? masked(approvedBy) : null,
    approvedAt: row.approvedAt.toISOString(),
    noticedAt: iso(row.noticedAt),
    noticedVia: row.noticedVia as TakeBackNoticedVia | null,
    dueAt: iso(row.dueAt),
    doneAt: iso(row.doneAt),
    cancelledAt: iso(row.cancelledAt),
    outcome: row.outcome as TakeBackOutcome | null,
    newHandle: row.newHandle,
  }));
}

export async function takeBackView(
  db: Database | Tx,
  id: string,
): Promise<OpsTakeBack | null> {
  const [view] = await takeBackViews(db, eq(handleTakeBacks.id, id), 1);
  return view ?? null;
}

/** The open take-back of a name, as staff see it. */
export async function openTakeBackView(
  db: Database | Tx,
  name: string,
): Promise<OpsTakeBack | null> {
  const row = await openTakeBackRow(db, name);
  return row ? takeBackView(db, row.id) : null;
}

/** Open take-backs, then the newest closed ones. */
export const listTakeBacks = (db: Database | Tx) =>
  takeBackViews(db, undefined, LIST_LIMIT);

/** Take-backs waiting for a second person, read through the stored payload. */
export async function pendingTakeBacks(
  db: Database | Tx,
  now: Date = new Date(),
): Promise<OpsTakeBackPending[]> {
  const rows = await db
    .select({
      requestId: approvalRequests.id,
      payload: approvalRequests.payload,
      requestedAt: approvalRequests.createdAt,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.action, TAKE_BACK_ACTION),
        eq(approvalRequests.status, 'pending'),
        sql`${approvalRequests.expiresAt} > ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(LIST_LIMIT);
  return rows.flatMap(({ requestId, payload, requestedAt }) => {
    const { name, profileId } = (payload ?? {}) as Partial<TakeBackPayload>;
    return typeof name === 'string' && typeof profileId === 'string'
      ? [
          {
            requestId,
            name,
            profileId,
            requestedAt: requestedAt.toISOString(),
          },
        ]
      : [];
  });
}

export type MyTakeBack = NonNullable<MyProfile['usernameTakeBack']>;

/** The page's open take-back, as its owner sees it: fixed words only, never who or why staff asked. */
export async function myTakeBack(
  db: Database | Tx,
  profileId: string,
  now: Date = new Date(),
): Promise<MyTakeBack | null> {
  const [row] = await db
    .select({
      id: handleTakeBacks.id,
      handle: handleTakeBacks.handleLower,
      kind: handleTakeBacks.kind,
      category: handleTakeBacks.category,
      noticeDays: handleTakeBacks.noticeDays,
      dueAt: handleTakeBacks.dueAt,
      current: profiles.handle,
    })
    .from(handleTakeBacks)
    .innerJoin(profiles, eq(profiles.id, handleTakeBacks.profileId))
    .where(
      and(
        eq(handleTakeBacks.profileId, profileId),
        inArray(handleTakeBacks.state, [...OPEN_STATES]),
      ),
    )
    // A page may have one on its current name and one on an old one: the current one matters most.
    .orderBy(
      sql`CASE WHEN ${handleTakeBacks.kind} = 'current' THEN 0 ELSE 1 END`,
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    handle: row.handle,
    kind: row.kind as TakeBackKind,
    dueAt: (row.dueAt ?? takeBackDueAt(now, row.noticeDays)).toISOString(),
    why: TAKE_BACK_WHY[row.category as TakeBackCategory],
    current: row.current,
  };
}

/**
 * The owner's dashboard showed the banner in a visible tab. The first time is recorded; if no sent
 * email has started the clock yet, this does (owner answer 1: the earlier of the two). Calling
 * again changes nothing. An id that isn't on the caller's page is not found.
 */
export function markTakeBackSeen(
  db: Database,
  input: { userId: string; takeBackId: string; now?: Date },
): Promise<MyTakeBack | null> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    if (!UUID.test(input.takeBackId))
      throw new OperationError('TAKE_BACK_NOT_FOUND');
    return db.transaction(async (tx) => {
      const [page] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.userId, input.userId))
        .for('update');
      if (!page) throw new OperationError('TAKE_BACK_NOT_FOUND');
      const row = await lockTakeBack(tx, input.takeBackId);
      if (!row || row.profileId !== page.id)
        throw new OperationError('TAKE_BACK_NOT_FOUND');
      if (isOpen(row.state) && row.bannerSeenAt === null) {
        const starts = row.noticedAt === null;
        await tx
          .update(handleTakeBacks)
          .set({
            bannerSeenAt: now,
            ...(starts
              ? {
                  state: 'noticed',
                  noticedAt: now,
                  noticedVia: 'banner',
                  dueAt: takeBackDueAt(now, row.noticeDays),
                }
              : {}),
          })
          .where(eq(handleTakeBacks.id, row.id));
        if (starts)
          await recordAudit(tx, {
            staffUserId: input.userId,
            action: 'username.take_back_noticed',
            subjectType: 'username',
            subjectId: row.handleLower,
            reason: withAuditChange('The owner saw the notice', {
              takeBackId: row.id,
              via: 'banner',
            }),
            now,
          });
      }
      return myTakeBack(tx, page.id, now);
    });
  });
}
