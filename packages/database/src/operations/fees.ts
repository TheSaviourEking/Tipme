import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '../client.js';
import { feeFreeCredits, profiles } from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import { addCredits } from './moments.js';

/**
 * Staff set (or clear, with `feeBps: null`) one account’s TipMe share, processing included (ADR-0014). New quotes use
 * it; quotes already given keep their price. Audited with its reason in the same transaction.
 */
export function setAccountFee(
  db: Database,
  input: {
    profileId: string;
    staffUserId: string;
    feeBps: number | null;
    reason: string;
  },
): Promise<{ handle: string; feeBps: number | null }> {
  if (
    input.feeBps !== null &&
    (!Number.isInteger(input.feeBps) ||
      input.feeBps < 0 ||
      input.feeBps > 10000)
  )
    return Promise.reject(new OperationError('INVALID_INPUT'));
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .update(profiles)
        .set({ customFeeBps: input.feeBps })
        .where(
          and(
            eq(profiles.id, input.profileId),
            ne(profiles.pageState, 'deleted'),
          ),
        )
        .returning({ handle: profiles.handle });
      if (!row) throw new OperationError('PROFILE_NOT_FOUND');
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action:
          input.feeBps === null ? 'fee.cleared' : `fee.set.${input.feeBps}`,
        permission: 'fees.manage',
        subjectType: 'profile',
        subjectId: input.profileId,
        reason: input.reason,
      });
      return { handle: row.handle, feeBps: input.feeBps };
    }),
  );
}

/** Staff grant fee-free tips to one account (ADR-0014), audited with the count and reason. */
export function grantFeeFreeTips(
  db: Database,
  input: {
    profileId: string;
    staffUserId: string;
    count: number;
    reason: string;
  },
): Promise<{ remaining: number }> {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100)
    return Promise.reject(new OperationError('INVALID_INPUT'));
  return guarded(() =>
    db.transaction(async (tx) => {
      const [profile] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.id, input.profileId),
            ne(profiles.pageState, 'deleted'),
          ),
        );
      if (!profile) throw new OperationError('PROFILE_NOT_FOUND');
      await addCredits(tx, input.profileId, input.count);
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: `fee_free.granted.${input.count}`,
        permission: 'fees.manage',
        subjectType: 'profile',
        subjectId: input.profileId,
        reason: input.reason,
      });
      const [credits] = await tx
        .select({ remaining: feeFreeCredits.remaining })
        .from(feeFreeCredits)
        .where(eq(feeFreeCredits.profileId, input.profileId));
      return { remaining: credits?.remaining ?? 0 };
    }),
  );
}

/** One page's pricing for staff, or null when there is no such (non-deleted) page. */
export function pagePricing(
  db: Database,
  profileId: string,
): Promise<{ customFeeBps: number | null; feeFreeRemaining: number } | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        customFeeBps: profiles.customFeeBps,
        remaining: feeFreeCredits.remaining,
      })
      .from(profiles)
      .leftJoin(feeFreeCredits, eq(feeFreeCredits.profileId, profiles.id))
      .where(
        and(eq(profiles.id, profileId), ne(profiles.pageState, 'deleted')),
      );
    return row
      ? { customFeeBps: row.customFeeBps, feeFreeRemaining: row.remaining ?? 0 }
      : null;
  });
}
