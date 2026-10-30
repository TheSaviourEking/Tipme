import { createHmac, hkdfSync } from 'node:crypto';
import { MAIL_TYPES, type MailProviderName } from '@tipme/mail';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { mailDailyStats, mailMessageEvents, mailMessages } from '../schema.js';
import { maskEmail, normaliseEmail } from './email-address.js';
import { OperationError } from './errors.js';
import { newId } from './ids.js';
import { sealSecret } from './secret-box.js';

/** The keys that seal mail at rest and hash addresses for the suppression list. */
export interface MailSealing {
  key: Buffer;
  hmacKey: Buffer;
}

/** From MAIL_SEAL_KEY (32 bytes). The HMAC key is derived, so one secret covers both. */
export function mailSealing(key: Buffer): MailSealing {
  if (key.length !== 32) throw new Error('MAIL_SEAL_KEY must be 32 bytes');
  return {
    key,
    hmacKey: Buffer.from(hkdfSync('sha256', key, '', 'mail-address', 32)),
  };
}

/** The suppression-list key for an address (normalised first). */
export function addressHmac(sealing: MailSealing, address: string): string {
  const normalised = normaliseEmail(address) ?? address.trim().toLowerCase();
  return createHmac('sha256', sealing.hmacKey).update(normalised).digest('hex');
}

const PRIORITY = { security: 0, account: 1 } as const;

/**
 * Queues one email in the caller's transaction, so it exists exactly when the change that caused
 * it commits. The data is checked against the type's schema first; a repeat of the same
 * `dedupeKey` changes nothing.
 */
export async function enqueueMail(
  tx: Database | Tx,
  sealing: MailSealing,
  input: {
    type: string;
    to: string;
    userId?: string | null;
    data: unknown;
    dedupeKey: string;
    expiresAt?: Date;
    pinnedProvider?: MailProviderName;
    now?: Date;
  },
): Promise<{ id: string; created: boolean }> {
  const type = MAIL_TYPES[input.type];
  if (!type) throw new OperationError('INVALID_INPUT');
  const to = normaliseEmail(input.to);
  if (!to) throw new OperationError('INVALID_INPUT');
  const data: unknown = type.schema.parse(input.data);
  const now = input.now ?? new Date();
  const id = newId();
  const inserted = await tx
    .insert(mailMessages)
    .values({
      id,
      type: type.id,
      category: type.category,
      userId: input.userId ?? null,
      dedupeKey: input.dedupeKey,
      toSealed: sealSecret(sealing.key, to),
      toHint: maskEmail(to),
      dataSealed: sealSecret(sealing.key, JSON.stringify(data)),
      priority: PRIORITY[type.category as keyof typeof PRIORITY] ?? 2,
      pinnedProvider: input.pinnedProvider ?? null,
      nextAttemptAt: now,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
    })
    .onConflictDoNothing({ target: mailMessages.dedupeKey })
    .returning({ id: mailMessages.id });
  if (!inserted[0]) {
    const [existing] = await tx
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(sql`${mailMessages.dedupeKey} = ${input.dedupeKey}`);
    return { id: existing?.id ?? id, created: false };
  }
  await recordMailEvent(tx, {
    messageId: id,
    kind: 'queued',
    occurredAt: now,
    type: type.id,
    category: type.category,
  });
  return { id, created: true };
}

/**
 * Appends one event to a message's history and counts it in that Lagos day's stats. A provider
 * event seen before (same provider and event id) is ignored: returns false.
 */
export async function recordMailEvent(
  tx: Database | Tx,
  event: {
    messageId: string | null;
    kind: string;
    provider?: string | null;
    providerEventId?: string | null;
    linkKey?: string | null;
    occurredAt: Date;
    type?: string;
    category?: string;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(mailMessageEvents)
    .values({
      id: newId(),
      messageId: event.messageId,
      kind: event.kind,
      provider: event.provider ?? null,
      providerEventId: event.providerEventId ?? null,
      linkKey: event.linkKey ?? null,
      occurredAt: event.occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: mailMessageEvents.id });
  if (inserted.length === 0) return false;
  if (event.type && event.category)
    await tx
      .insert(mailDailyStats)
      .values({
        lagosDate: sql`(${event.occurredAt.toISOString()}::timestamptz AT TIME ZONE 'Africa/Lagos')::date`,
        type: event.type,
        category: event.category,
        provider: event.provider ?? '',
        kind: event.kind,
        count: 1,
      })
      .onConflictDoUpdate({
        target: [
          mailDailyStats.lagosDate,
          mailDailyStats.type,
          mailDailyStats.category,
          mailDailyStats.provider,
          mailDailyStats.kind,
        ],
        set: { count: sql`${mailDailyStats.count} + 1` },
      });
  return true;
}
