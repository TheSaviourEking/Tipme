import { queueAnnouncementBatch } from '@tipme/database';
import type { Database, MailSealing } from '@tipme/database';

/** How often the job runs. Short, so the rate stays steady rather than a burst each minute. */
export const ANNOUNCEMENTS_TICK_MS = 10_000;

/** People queued per tick for a rate per minute: the tick's share, rounded up, at least one. */
export function announcementBatchSize(sendsPerMinute: number): number {
  return Math.max(
    1,
    Math.ceil((sendsPerMinute * ANNOUNCEMENTS_TICK_MS) / 60_000),
  );
}

/**
 * The `announcements.send` job, every 10 seconds: queues the next batch of the oldest announcement
 * being sent (staff announcements, 14 Nov 2026). The batch and its progress commit together and
 * each email's dedupe key is per person, so a repeat after a restart, or two workers, mail nobody
 * twice. Missed ticks are not caught up: the rate is a ceiling, never a burst.
 */
export async function handleAnnouncements(deps: {
  db: Database;
  sealing: MailSealing;
  sendsPerMinute: number;
  now: () => Date;
  log?: (entry: Record<string, unknown>) => void;
  /** For tests: the batch itself has its own integration tests. */
  queueBatch?: typeof queueAnnouncementBatch;
}): Promise<'announcements_queued' | 'announcements_idle'> {
  const result = await (deps.queueBatch ?? queueAnnouncementBatch)(
    deps.db,
    deps.sealing,
    { now: deps.now(), limit: announcementBatchSize(deps.sendsPerMinute) },
  );
  if (!result.announcementId) return 'announcements_idle';
  deps.log?.({
    event: 'announcements.batch',
    announcement_id: result.announcementId,
    queued: result.queued,
    finished: result.finished,
  });
  return 'announcements_queued';
}
