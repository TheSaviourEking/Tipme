import { eq, and, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  approvalRequests,
  paymentAttempts,
  payouts,
  profiles,
  staff,
  tips,
  users,
} from '../schema.js';
import type { Database, Tx } from '../client.js';
import { maskEmail } from './email-address.js';
import { guarded } from './errors.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';
import { qualifiedApprovers } from './serious-actions.js';

type Owner = { userId: string } | { profileId: string };

/**
 * Queues an email to an account's verified address, in the caller's transaction, so it exists only
 * if the operation does. An account with no verified address simply gets no email.
 */
export async function mailOwner(
  tx: Tx | Database,
  sealing: MailSealing,
  input: Owner & {
    type: string;
    data: Record<string, unknown>;
    dedupeKey: string;
    now?: Date;
  },
): Promise<void> {
  const [owner] =
    'userId' in input
      ? await tx
          .select({ userId: users.id, email: users.email })
          .from(users)
          .where(
            and(
              eq(users.id, input.userId),
              isNotNull(users.emailVerifiedAt),
              isNull(users.deletedAt),
            ),
          )
      : await tx
          .select({ userId: users.id, email: users.email })
          .from(profiles)
          .innerJoin(users, eq(users.id, profiles.userId))
          .where(
            and(
              eq(profiles.id, input.profileId),
              isNotNull(users.emailVerifiedAt),
              isNull(users.deletedAt),
            ),
          );
  if (!owner?.email) return;
  await enqueueMail(tx as Tx, sealing, {
    type: input.type,
    to: owner.email,
    userId: owner.userId,
    data: input.data,
    dedupeKey: input.dedupeKey,
    ...(input.now ? { now: input.now } : {}),
  });
}

const UUID = /^[0-9a-f-]{36}$/;
const idOf = (value: unknown) =>
  typeof value === 'string' && UUID.test(value) ? value : null;

const verifiedOwners = (db: Database) =>
  db
    .select({ userId: users.id, email: users.email })
    .from(staff)
    .innerJoin(users, eq(users.id, staff.userId))
    .where(
      and(
        eq(staff.roleId, 'owner'),
        isNull(staff.revokedAt),
        isNotNull(users.emailVerifiedAt),
        isNull(users.deletedAt),
      ),
    );

/**
 * Emails caused by outbox events. The outbox row commits with the operation, so these can't exist
 * without it, and each dedupe key makes a repeated delivery a no-op.
 */
/** Every owner hears, the person who acted included: it may not have been them at the keyboard. */
async function mailOwnersActedAlone(
  db: Database,
  sealing: MailSealing,
  payload: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void> {
  const actorId = idOf(payload['requestedBy']);
  const action = payload['action'];
  if (!actorId || typeof action !== 'string' || !dedupeKey) return;
  const [actor] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, actorId));
  for (const owner of await verifiedOwners(db))
    if (owner.email)
      await enqueueMail(db, sealing, {
        type: 'staff_acted_alone',
        to: owner.email,
        userId: owner.userId,
        data: {
          personHint: actor?.email ? maskEmail(actor.email) : 'A staff member',
          action,
        },
        // A retried event sends nothing twice; each action is its own event.
        dedupeKey: `staff_acted_alone.${dedupeKey}.${owner.userId}`,
      });
}

/** Everyone who could decide it, while it can still be decided; never the person who asked. */
async function mailApprovalPending(
  db: Database,
  sealing: MailSealing,
  payload: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void> {
  const requestId = idOf(payload['requestId']);
  if (!requestId || !dedupeKey) return;
  const [request] = await db
    .select({
      action: approvalRequests.action,
      permission: approvalRequests.permission,
      requestedBy: approvalRequests.requestedBy,
      status: approvalRequests.status,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId));
  if (request?.status !== 'pending') return;
  const [asker] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, request.requestedBy));
  const able = await qualifiedApprovers(db, {
    permission: request.permission,
    requesterId: request.requestedBy,
  });
  if (able.length === 0) return;
  const recipients = await db
    .select({ userId: users.id, email: users.email })
    .from(users)
    .where(
      and(
        inArray(users.id, able),
        isNotNull(users.emailVerifiedAt),
        isNull(users.deletedAt),
      ),
    );
  for (const recipient of recipients)
    if (recipient.email)
      await enqueueMail(db, sealing, {
        type: 'staff_approval_pending',
        to: recipient.email,
        userId: recipient.userId,
        data: {
          personHint: asker?.email ? maskEmail(asker.email) : 'A staff member',
          action: request.action,
        },
        dedupeKey: `staff_approval_pending.${dedupeKey}.${recipient.userId}`,
      });
}

/** Every owner hears, as with acting alone. */
async function mailLastApproverRemoved(
  db: Database,
  sealing: MailSealing,
  payload: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void> {
  const permissions = payload['permissions'];
  if (typeof permissions !== 'string' || !dedupeKey) return;
  const actorId = idOf(payload['requestedBy']);
  const [actor] = actorId
    ? await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, actorId))
    : [];
  for (const owner of await verifiedOwners(db))
    if (owner.email)
      await enqueueMail(db, sealing, {
        type: 'staff_last_approver_removed',
        to: owner.email,
        userId: owner.userId,
        data: {
          personHint: actor?.email
            ? maskEmail(actor.email)
            : actorId
              ? 'A staff member'
              : 'the server command',
          permissions,
        },
        dedupeKey: `staff_last_approver_removed.${dedupeKey}.${owner.userId}`,
      });
}

export function mailForDomainEvent(
  db: Database,
  sealing: MailSealing,
  name: string,
  data: unknown,
  dedupeKey?: string,
): Promise<void> {
  const payload = (data ?? {}) as Record<string, unknown>;
  return guarded(async () => {
    if (name === 'ops.acted_alone') {
      await mailOwnersActedAlone(db, sealing, payload, dedupeKey);
      return;
    }
    if (name === 'ops.approval_pending') {
      await mailApprovalPending(db, sealing, payload, dedupeKey);
      return;
    }
    if (name === 'ops.last_approver_removed') {
      await mailLastApproverRemoved(db, sealing, payload, dedupeKey);
      return;
    }
    if (name === 'payout.paid' || name === 'payout.failed') {
      const payoutId = idOf(payload['payoutId']);
      if (!payoutId) return;
      const [payout] = await db
        .select({ profileId: payouts.profileId, amount: payouts.amountMinor })
        .from(payouts)
        .where(eq(payouts.id, payoutId));
      if (!payout) return;
      const type =
        name === 'payout.paid' ? 'withdrawal_paid' : 'withdrawal_failed';
      await mailOwner(db, sealing, {
        profileId: payout.profileId,
        type,
        data: { amountMinor: payout.amount.toString() },
        dedupeKey: `${type}.${payoutId}`,
      });
      return;
    }
    if (name === 'payment.reversed') {
      const attemptId = idOf(payload['attemptId']);
      if (!attemptId) return;
      const [tip] = await db
        .select({ id: tips.id, profileId: tips.profileId })
        .from(paymentAttempts)
        .innerJoin(tips, eq(tips.intentId, paymentAttempts.intentId))
        .where(eq(paymentAttempts.id, attemptId));
      if (!tip) return;
      // One per provider event: a refund and a later dispute are different news.
      const suffix = (dedupeKey ?? attemptId).replace(/[^\w.-]/g, '_');
      await mailOwner(db, sealing, {
        profileId: tip.profileId,
        type: 'tip_reversed',
        data: {},
        dedupeKey: `tip_reversed.${tip.id}.${suffix}`,
      });
    }
  });
}
