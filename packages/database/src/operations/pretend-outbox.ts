import { desc } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { pretendOutbox } from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';

export type PretendChannel = 'whatsapp' | 'sms' | 'email';

/** Records what a real messenger or mailbox would have delivered. Development only. */
export async function writePretendMessage(
  tx: Database | Tx,
  message: {
    channel: PretendChannel;
    recipientHint: string;
    userId?: string | null;
    subject?: string | null;
    body: string;
  },
): Promise<void> {
  await tx.insert(pretendOutbox).values({
    id: newId(),
    channel: message.channel,
    recipientHint: message.recipientHint,
    userId: message.userId ?? null,
    subject: message.subject ?? null,
    body: message.body,
  });
}

export function listPretendOutbox(
  db: Database,
  { limit }: { limit: number },
): Promise<
  {
    id: string;
    channel: string;
    recipientHint: string;
    subject: string | null;
    body: string;
    createdAt: Date;
  }[]
> {
  return guarded(() =>
    db
      .select({
        id: pretendOutbox.id,
        channel: pretendOutbox.channel,
        recipientHint: pretendOutbox.recipientHint,
        subject: pretendOutbox.subject,
        body: pretendOutbox.body,
        createdAt: pretendOutbox.createdAt,
      })
      .from(pretendOutbox)
      .orderBy(desc(pretendOutbox.seq))
      .limit(Math.min(Math.max(limit, 1), 100)),
  );
}
