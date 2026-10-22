import type { MessageReportReason } from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { messageFlags } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { openIssue } from './issues.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The tip, only if it belongs to this page, is paid and carries a message. */
async function ownMessage(
  db: Database,
  profileId: string,
  tipId: string,
): Promise<void> {
  if (!UUID.test(tipId)) throw new OperationError('NO_PAGE');
  const rows = await db.execute<{ id: string }>(sql`
    SELECT t.id FROM tips t JOIN tip_messages m ON m.tip_id = t.id
     WHERE t.id = ${tipId} AND t.profile_id = ${profileId} AND t.status = 'SUCCEEDED'`);
  if (!rows.rows[0]) throw new OperationError('NO_PAGE');
}

/** The recipient hides a supporter's message from their own views (FR-010). */
export function hideMessage(
  db: Database,
  input: { profileId: string; tipId: string; now?: Date },
): Promise<void> {
  return guarded(async () => {
    await ownMessage(db, input.profileId, input.tipId);
    await db
      .insert(messageFlags)
      .values({ tipId: input.tipId, hiddenAt: input.now ?? new Date() })
      .onConflictDoNothing();
  });
}

/**
 * The recipient reports a message (FR-010, PRD §3.4 "abusive message"): it is hidden from them and
 * opens one `message_reported` issue. Staff see the text only through a reason-recorded reveal.
 */
export function reportMessage(
  db: Database,
  input: {
    profileId: string;
    tipId: string;
    reason: MessageReportReason;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  return guarded(async () => {
    await ownMessage(db, input.profileId, input.tipId);
    await db.transaction(async (tx) => {
      await tx
        .insert(messageFlags)
        .values({
          tipId: input.tipId,
          hiddenAt: now,
          reportedAt: now,
          reportReason: input.reason,
        })
        .onConflictDoUpdate({
          target: messageFlags.tipId,
          set: {
            reportedAt: sql`coalesce(${messageFlags.reportedAt}, ${now})`,
            reportReason: input.reason,
          },
        });
      await openIssue(tx, {
        dedupeKey: `message_report.${input.tipId}`,
        kind: 'message_reported',
        subject: { tipId: input.tipId, profileId: input.profileId },
        now,
      });
    });
  });
}
