import type { NotificationView } from '@tipme/contracts';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  notifications,
  paymentIntents,
  profiles,
  tipQuotes,
  tips,
  users,
} from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';

const ngn = (minor: bigint) =>
  `NGN ${new Intl.NumberFormat('en').format(Number(minor / 100n))}.${String(minor % 100n).padStart(2, '0')}`;

/**
 * Tells the recipient about a confirmed tip: an in-app notification, and an email in the pretend
 * mailbox when they have a verified address. Once per tip, however often the event arrives.
 * Only ever called for verified tips (the `tip.succeeded` outbox event).
 */
export function notifyTipSucceeded(
  db: Database,
  input: {
    sealing: MailSealing;
    tipId: string;
    profileId: string;
    now?: Date;
    /** True while payments are pretend (the mock provider), so the email says so. */
    pretendPayment?: boolean;
  },
): Promise<'created' | 'duplicate' | 'skipped'> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          status: tips.status,
          label: tips.payerDisplayLabel,
          net: tipQuotes.recipientNetMinor,
          userId: profiles.userId,
          displayName: profiles.displayName,
          email: users.email,
          emailVerifiedAt: users.emailVerifiedAt,
          wantsEmail: profiles.notifyTipEmails,
        })
        .from(tips)
        .innerJoin(paymentIntents, eq(paymentIntents.id, tips.intentId))
        .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
        .innerJoin(profiles, eq(profiles.id, tips.profileId))
        .leftJoin(users, eq(users.id, profiles.userId))
        .where(
          and(eq(tips.id, input.tipId), eq(tips.profileId, input.profileId)),
        );
      if (!row || row.status !== 'SUCCEEDED' || !row.userId)
        return 'skipped' as const;
      const inserted = await tx
        .insert(notifications)
        .values({
          id: newId(),
          userId: row.userId,
          kind: 'tip',
          tipId: input.tipId,
          title: 'You got a tip',
          body: `${ngn(row.net)} from ${row.label ?? 'a guest'}`,
          ...(input.now ? { createdAt: input.now } : {}),
        })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      if (inserted.length === 0) return 'duplicate' as const;
      // The in-app notice always goes; the email only if the recipient wants tip emails (PR-013).
      if (row.email && row.emailVerifiedAt && row.wantsEmail) {
        await enqueueMail(tx, input.sealing, {
          type: 'tip_received',
          to: row.email,
          userId: row.userId,
          data: {
            firstName: row.displayName.split(/\s+/)[0] || row.displayName,
            netMinor: row.net.toString(),
            supporterLabel: row.label,
            pretendPayment: input.pretendPayment ?? false,
          },
          dedupeKey: `tip_received.${input.tipId}`,
          ...(input.now ? { now: input.now } : {}),
        });
      }
      return 'created' as const;
    }),
  );
}

export function listNotifications(
  db: Database,
  userId: string,
  { unreadOnly = false }: { unreadOnly?: boolean },
): Promise<NotificationView[]> {
  return guarded(async () => {
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          ...(unreadOnly ? [isNull(notifications.readAt)] : []),
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      tipId: row.tipId,
      momentId: row.momentId,
      reportId: row.reportId,
      title: row.title,
      body: row.body,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

/** Marks the user's own notifications read; ids belonging to anyone else are ignored. */
export function markRead(
  db: Database,
  userId: string,
  ids: string[],
): Promise<void> {
  const valid = ids.filter((id) => /^[0-9a-f-]{36}$/.test(id)).slice(0, 100);
  if (valid.length === 0) return Promise.resolve();
  return guarded(async () => {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, userId),
          inArray(notifications.id, valid),
          isNull(notifications.readAt),
        ),
      );
  });
}
