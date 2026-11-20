import { and, eq, isNull } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { paymentAccounts, profiles } from '../schema.js';

/*
 * You collect (ADR-0016, PROPOSED; ruling R7): who collects a recipient's tips. `direct` is today's
 * flow, on the recipient's own partner account; `collect` is TipMe's own account. The profile's
 * column is null until decided, and null behaves as `direct`. A quote copies the mode, and every
 * later step reads the quote's, never the profile's (plan, "mode is fixed per tip").
 */

export type CollectionMode = 'direct' | 'collect';

/**
 * Whether a recipient may be put on `collect` now (ruling P11). Every new `collect` assignment, at
 * sign-up and at a first quote, asks this one helper. For now it always allows. Plan Task 11 makes it
 * refuse while TipMe's own money is below the critical line, so new sign-ups pause there (spec §6.3).
 * A refusal leaves the recipient undecided (null, so `direct`): it never moves anyone already on
 * `collect`.
 */
export async function mayAssignCollect(tx: Database | Tx): Promise<boolean> {
  // Task 11 reads TipMe's own money in this transaction; nothing to read yet.
  void tx;
  return true;
}

/**
 * The mode a new sign-up's profile is written with: `collect` while the switch is on and
 * mayAssignCollect allows it, otherwise null (undecided), as today.
 */
export async function signUpCollectionMode(
  db: Database | Tx,
  youCollectOn: boolean | undefined,
): Promise<'collect' | null> {
  if (!youCollectOn) return null;
  return (await mayAssignCollect(db)) ? 'collect' : null;
}

/** A recipient's mode as it stands: null (undecided) reads as `direct`. Never writes. */
export async function collectionModeOf(
  db: Database | Tx,
  profileId: string,
): Promise<CollectionMode> {
  const [row] = await db
    .select({ mode: profiles.collectionMode })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  return row?.mode === 'collect' ? 'collect' : 'direct';
}

/**
 * Decides an undecided recipient's mode, once (R7), for a quote made while the switch is on. An
 * ACTIVE payment account on this provider and environment keeps `direct`; anything else gives
 * `collect` (they can't take tips today). Once written it is never rewritten here, and a recipient
 * already decided keeps their mode. Concurrent quotes agree: only the first write lands, and every
 * caller reads that one back.
 */
export async function decideCollectionMode(
  tx: Tx,
  i: {
    profileId: string;
    switchOn: boolean;
    provider: string;
    environment: string;
  },
): Promise<CollectionMode> {
  const [row] = await tx
    .select({ mode: profiles.collectionMode })
    .from(profiles)
    .where(eq(profiles.id, i.profileId));
  if (row?.mode === 'direct' || row?.mode === 'collect') return row.mode;
  if (!i.switchOn || !row) return 'direct';
  const environment =
    i.environment === 'live' || i.environment === 'sandbox'
      ? i.environment
      : null;
  const [active] = environment
    ? await tx
        .select({ id: paymentAccounts.id })
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.profileId, i.profileId),
            eq(paymentAccounts.provider, i.provider),
            eq(paymentAccounts.environment, environment),
            eq(paymentAccounts.status, 'ACTIVE'),
          ),
        )
    : [];
  let decided: CollectionMode = active ? 'direct' : 'collect';
  // Refused (Task 11): left undecided, so the next quote asks again.
  if (decided === 'collect' && !(await mayAssignCollect(tx))) return 'direct';
  const [written] = await tx
    .update(profiles)
    .set({ collectionMode: decided })
    .where(and(eq(profiles.id, i.profileId), isNull(profiles.collectionMode)))
    .returning({ mode: profiles.collectionMode });
  if (!written) decided = await collectionModeOf(tx, i.profileId);
  return decided;
}
