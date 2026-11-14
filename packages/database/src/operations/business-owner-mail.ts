import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { businesses, businessManagers, profiles } from '../schema.js';
import { mailOwner } from './account-mail.js';
import type { MailSealing } from './mail-queue.js';

// Owner-change emails (owner, 14 Nov 2026): every owner of a business hears when its owners change,
// or when an owner asks to remove another and is refused, the person the change is about and the
// person who asked included. Queued in the caller's transaction, so they exist only if it commits.

export type OwnerChange =
  'removal_blocked' | 'removed_by_tipme' | 'stepped_down';

/** The name a manager's own page shows, as the Managers list shows it: never a phone or an email. */
async function shownName(tx: Tx, userId: string): Promise<string> {
  const [row] = await tx
    .select({ displayName: profiles.displayName, handle: profiles.handle })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return row?.displayName || (row?.handle ? `@${row.handle}` : 'A TipMe user');
}

export async function mailOwnerChange(
  tx: Tx,
  sealing: MailSealing,
  input: {
    businessId: string;
    change: OwnerChange;
    /** The owner the change is about. */
    ownerUserId: string;
    /** Who asked, for a refused removal. */
    actorUserId?: string;
    /** Makes each email's dedupe key: one per event and person. */
    eventId: string;
    now: Date;
  },
): Promise<void> {
  const [business] = await tx
    .select({ name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, input.businessId));
  if (!business) return;
  const owners = await tx
    .select({ userId: businessManagers.userId })
    .from(businessManagers)
    .where(
      and(
        eq(businessManagers.businessId, input.businessId),
        eq(businessManagers.role, 'owner'),
        isNull(businessManagers.removedAt),
      ),
    );
  const recipients = new Set([
    ...owners.map((owner) => owner.userId),
    input.ownerUserId,
    ...(input.actorUserId ? [input.actorUserId] : []),
  ]);
  const ownerName = await shownName(tx, input.ownerUserId);
  const actorName =
    input.change === 'removal_blocked' && input.actorUserId
      ? await shownName(tx, input.actorUserId)
      : undefined;
  for (const userId of [...recipients].sort())
    await mailOwner(tx, sealing, {
      userId,
      type: 'business_owner_change',
      data: {
        change: input.change,
        businessName: business.name,
        ownerName,
        ...(actorName ? { actorName } : {}),
        you:
          input.change === 'removal_blocked' && userId === input.actorUserId
            ? 'actor'
            : userId === input.ownerUserId
              ? 'owner'
              : 'other',
      },
      dedupeKey: `business_owner_change.${input.change}.${input.eventId}.${userId}`,
      now: input.now,
    });
}
