import { createHash } from 'node:crypto';
import { SUPPORTER_KEY_PATTERN } from '@tipme/contracts';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { supporters, tipSupporters } from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';

// Repeat supporters (Pro additions, option (a)). The browser keeps a random key per recipient;
// only its SHA-256 reaches this table. Never log, return or audit the key or its hash.

/** The one-way hash stored for a supporter key; null for anything that is not a key. */
export function supporterKeyHash(key: string | undefined): Buffer | null {
  if (key === undefined || !SUPPORTER_KEY_PATTERN.test(key)) return null;
  return createHash('sha256').update(key).digest();
}

/**
 * Inside the tip's own transaction: finds or makes this recipient's supporter for the key, keeps the
 * newest name, and links the tip. A failure here rolls the whole tip back.
 */
export async function recordSupporter(
  tx: Tx,
  input: {
    profileId: string;
    keyHash: Buffer;
    label: string;
    tipId: string;
    now: Date;
  },
): Promise<void> {
  const [row] = await tx
    .insert(supporters)
    .values({
      id: newId(),
      profileId: input.profileId,
      keyHash: input.keyHash,
      label: input.label,
      firstAt: input.now,
      lastAt: input.now,
    })
    .onConflictDoUpdate({
      target: [supporters.profileId, supporters.keyHash],
      // The name from the latest tip wins, whatever order concurrent tips commit in.
      set: {
        label: sql`CASE WHEN excluded.last_at >= ${supporters.lastAt} THEN excluded.label ELSE ${supporters.label} END`,
        lastAt: sql`GREATEST(${supporters.lastAt}, excluded.last_at)`,
      },
    })
    .returning({ id: supporters.id });
  if (!row) throw new Error('supporter upsert returned nothing');
  await tx
    .insert(tipSupporters)
    .values({ tipId: input.tipId, supporterId: row.id });
}

/**
 * "Stop {name} recognising me", from a receipt (the API has checked its status token). Deletes the
 * tip's supporter, and with it every link to their past tips with this recipient; the tips and
 * notes themselves stay. True when something was stopped; false when there was nothing to stop.
 */
export function stopRecognition(db: Database, tipId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(tipId)) return Promise.resolve(false);
  return guarded(async () => {
    const removed = await db
      .delete(supporters)
      .where(
        inArray(
          supporters.id,
          db
            .select({ id: tipSupporters.supporterId })
            .from(tipSupporters)
            .where(eq(tipSupporters.tipId, tipId)),
        ),
      )
      .returning({ id: supporters.id });
    return removed.length > 0;
  });
}

/** Whether a tip is linked to an opted-in supporter (the receipt's "recognised"). */
export async function tipIsRecognised(
  db: Database | Tx,
  tipId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ tipId: tipSupporters.tipId })
    .from(tipSupporters)
    .where(eq(tipSupporters.tipId, tipId));
  return row !== undefined;
}
