import { and, eq, isNull } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { paymentAccounts, profiles } from '../schema.js';
import { collectSignupsPaused } from './collect-reserve.js';

/*
 * You collect (ADR-0016, PROPOSED; ruling R7): who collects a recipient's tips. `direct` is today's
 * flow, on the recipient's own partner account; `collect` is TipMe's own account. The profile's
 * column is null until decided, and null behaves as `direct`. A quote copies the mode, and every
 * later step reads the quote's, never the profile's (plan, "mode is fixed per tip").
 */

export type CollectionMode = 'direct' | 'collect';

/**
 * Whether a recipient may be put on `collect` now (ruling P11). Every new `collect` assignment, at
 * sign-up and at a first quote (and Task 14's read-only preview, which shares the quote's rules),
 * asks this one helper. Task 11: it refuses while TipMe's reserve rule is broken (an open
 * `collect_invariant_broken` issue, spec §6.3), so new sign-ups pause until staff clear it. A refusal
 * leaves the recipient undecided (null, so `direct`): it never moves anyone already on `collect`.
 * The check is injected so it can be tested at run time; by default it reads the issue.
 */
export async function mayAssignCollect(
  tx: Database | Tx,
  deps: { signupsPaused?: (db: Database | Tx) => Promise<boolean> } = {},
): Promise<boolean> {
  return !(await (deps.signupsPaused ?? collectSignupsPaused)(tx));
}

/**
 * The mode a new sign-up's profile is written with: `collect` while the switch is on and
 * mayAssignCollect allows it, otherwise null (undecided), as today. claimHandle calls it inside the
 * transaction that inserts the page, so the check and the write are one unit (Task 11's read too).
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
 * Decides an undecided recipient's mode, once (R7), for a quote made while the switch is on, by
 * their payment account on this provider and environment (rulings P22, P23):
 * - none, CREATING or ONBOARDING: `collect` (they can't take tips today), if mayAssignCollect allows;
 * - ACTIVE: `direct`, as today;
 * - RESTRICTED or FAILED: `direct`, so the partner's refusal still blocks them
 *   (PAYMENT_ACCOUNT_REQUIRED), as today;
 * - UNKNOWN (the account may exist at the partner): left undecided and quoted `direct`; a later
 *   quote decides once the status is known.
 * Once written it is never rewritten here, and a recipient already decided keeps their mode.
 * Concurrent quotes agree: only the first write lands, and every caller reads that one back.
 */
export async function decideCollectionMode(
  tx: Tx,
  i: CollectionModeInputs,
): Promise<CollectionMode> {
  const rule = await nextCollectionMode(tx, i);
  if (!rule.write) return rule.mode;
  const [written] = await tx
    .update(profiles)
    .set({ collectionMode: rule.mode })
    .where(and(eq(profiles.id, i.profileId), isNull(profiles.collectionMode)))
    .returning({ mode: profiles.collectionMode });
  return written ? rule.mode : await collectionModeOf(tx, i.profileId);
}

/** What decides a recipient's mode: the switch, and the provider and environment a quote uses. */
export interface CollectionModeInputs {
  profileId: string;
  switchOn: boolean;
  provider: string;
  environment: string;
}

/**
 * The mode a recipient is on, or (undecided) the one their next quote would fix now, by
 * decideCollectionMode's own rules, without writing anything (Task 14, re-review 2 R2-I1). An
 * undecided recipient the next quote would put on collect is shown You collect from now, so the
 * screens agree with where a supporter's tip would go. Reads only.
 */
export async function previewCollectionMode(
  db: Database | Tx,
  i: CollectionModeInputs,
): Promise<CollectionMode> {
  return (await nextCollectionMode(db, i)).mode;
}

/**
 * decideCollectionMode's rules, read-only: the mode, and whether a quote would write it (an
 * undecided recipient it decides). Shared, so the preview and the write can never disagree.
 */
async function nextCollectionMode(
  db: Database | Tx,
  i: CollectionModeInputs,
): Promise<{ mode: CollectionMode; write: boolean }> {
  const [row] = await db
    .select({ mode: profiles.collectionMode })
    .from(profiles)
    .where(eq(profiles.id, i.profileId));
  if (row?.mode === 'direct' || row?.mode === 'collect')
    return { mode: row.mode, write: false };
  if (!i.switchOn || !row) return { mode: 'direct', write: false };
  const environment =
    i.environment === 'live' || i.environment === 'sandbox'
      ? i.environment
      : null;
  // One row per profile, provider and environment (the table's unique key).
  const [account] = environment
    ? await db
        .select({ status: paymentAccounts.status })
        .from(paymentAccounts)
        .where(
          and(
            eq(paymentAccounts.profileId, i.profileId),
            eq(paymentAccounts.provider, i.provider),
            eq(paymentAccounts.environment, environment),
          ),
        )
    : [];
  const status = account?.status ?? null;
  // P23: never collect while an account may exist at the partner; ask again next quote.
  if (status === 'UNKNOWN') return { mode: 'direct', write: false };
  const decided: CollectionMode =
    status === null || status === 'CREATING' || status === 'ONBOARDING'
      ? 'collect'
      : 'direct';
  // Refused (Task 11, sign-ups paused): left undecided, so the next quote asks again.
  if (decided === 'collect' && !(await mayAssignCollect(db)))
    return { mode: 'direct', write: false };
  return { mode: decided, write: true };
}
