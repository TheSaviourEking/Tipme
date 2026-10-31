import { eq, and, isNotNull, isNull } from 'drizzle-orm';
import { paymentAttempts, payouts, profiles, tips, users } from '../schema.js';
import type { Database, Tx } from '../client.js';
import { guarded } from './errors.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';

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

/**
 * Emails caused by outbox events. The outbox row commits with the operation, so these can't exist
 * without it, and each dedupe key makes a repeated delivery a no-op.
 */
export function mailForDomainEvent(
  db: Database,
  sealing: MailSealing,
  name: string,
  data: unknown,
  dedupeKey?: string,
): Promise<void> {
  const payload = (data ?? {}) as Record<string, unknown>;
  return guarded(async () => {
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
