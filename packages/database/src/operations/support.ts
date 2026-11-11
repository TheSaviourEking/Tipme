import {
  SUPPORT_OPEN_LIMIT,
  SUPPORT_TOPIC_WORDS,
  type MySupportRequest,
  type SupportTopic,
} from '@tipme/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { issues, profiles, supportRequests } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';

// Priority support (owner default ruling 7). A request opens an ops issue; the person's words stay
// in support_requests and staff read them through the audited reveal (private.view). A Pro
// member's request is marked priority (the plan when sent) and sorted first in the open queue.

/** Sends a request: one issue each; at most 3 waiting per person. */
export function sendSupportRequest(
  db: Database,
  input: { userId: string; topic: SupportTopic; body: string; now?: Date },
): Promise<{ id: string; priority: boolean }> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      // The person's page, locked so parallel sends can't pass the limit together.
      const [page] = await tx
        .select({ id: profiles.id, plan: profiles.plan })
        .from(profiles)
        .where(eq(profiles.userId, input.userId))
        .for('update');
      const waiting = await tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM support_requests s JOIN issues i ON i.id = s.issue_id
         WHERE s.user_id = ${input.userId} AND i.status = 'open'`);
      if ((waiting.rows[0]?.n ?? 0) >= SUPPORT_OPEN_LIMIT)
        throw new OperationError('SUPPORT_TOO_MANY_OPEN');
      const priority = page?.plan === 'pro';
      const id = newId();
      const issue = await openIssue(tx, {
        dedupeKey: `support.${id}`,
        kind: 'support_request',
        subject: {
          userId: input.userId,
          ...(page ? { profileId: page.id } : {}),
          requestId: id,
        },
        // Fixed words only: never the person's own text.
        note: `Topic: ${SUPPORT_TOPIC_WORDS[input.topic]}.${priority ? ' Pro member: answer first.' : ''}`,
        priority,
        now,
      });
      await tx.insert(supportRequests).values({
        id,
        issueId: issue.id,
        userId: input.userId,
        profileId: page?.id ?? null,
        topic: input.topic,
        body: input.body,
        priority,
        createdAt: now,
      });
      return { id, priority };
    }),
  );
}

/** The person's own requests, newest first: topic, date and state only. */
export function listMySupportRequests(
  db: Database,
  userId: string,
): Promise<MySupportRequest[]> {
  return guarded(async () => {
    const rows = await db
      .select({
        id: supportRequests.id,
        topic: supportRequests.topic,
        createdAt: supportRequests.createdAt,
        priority: supportRequests.priority,
        status: issues.status,
      })
      .from(supportRequests)
      .innerJoin(issues, eq(issues.id, supportRequests.issueId))
      .where(eq(supportRequests.userId, userId))
      .orderBy(desc(supportRequests.createdAt))
      .limit(20);
    return rows.map((row) => ({
      id: row.id,
      topic: row.topic as SupportTopic,
      createdAt: row.createdAt.toISOString(),
      status: row.status === 'open' ? 'waiting' : 'closed',
      priority: row.priority,
    }));
  });
}

/** The words of the request an issue is about, for the audited reveal only. */
export async function supportRequestBody(
  db: Database,
  issueId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ body: supportRequests.body })
    .from(supportRequests)
    .where(eq(supportRequests.issueId, issueId));
  return row?.body ?? null;
}
