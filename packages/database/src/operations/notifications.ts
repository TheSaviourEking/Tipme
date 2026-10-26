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
import { writePretendMessage } from './pretend-outbox.js';
import { maskEmail } from './email.js';

const ngn = (minor: bigint) =>
  `NGN ${new Intl.NumberFormat('en').format(Number(minor / 100n))}.${String(minor % 100n).padStart(2, '0')}`;
const nairaWhole = (minor: bigint) =>
  `₦${new Intl.NumberFormat('en').format(Number(minor / 100n))}`;

/**
 * Tells the recipient about a confirmed tip: an in-app notification, and an email in the pretend
 * mailbox when they have a verified address. Once per tip, however often the event arrives.
 * Only ever called for verified tips (the `tip.succeeded` outbox event).
 */
export function notifyTipSucceeded(
  db: Database,
  input: { tipId: string; profileId: string; now?: Date },
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
        const first = row.displayName.split(/\s+/)[0];
        await writePretendMessage(tx, {
          channel: 'email',
          recipientHint: maskEmail(row.email),
          userId: row.userId,
          subject: `You got a ${nairaWhole(row.net)} tip on TipMe`,
          body: `${first}, you got a tip of ${ngn(row.net)} from ${row.label ?? 'a guest'}. It is confirmed by the payment provider. (Pretend payment: no real money moved.)`,
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
