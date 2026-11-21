import type { Database, MailSealing } from '@tipme/database';
import { sendCollectReminders } from '@tipme/database';

/*
 * You collect (plan Task 12, spec §2.1 step 3): with each transfer sweep, recipients with tips
 * waiting and no bank details are reminded on the reminder days. Each reminder is stored once by its
 * dedupe key, so a repeated or overlapping sweep sends nothing twice.
 */

export type CollectRemindersLog = (entry: {
  event: string;
  error?: string;
}) => void;

/**
 * One reminder pass. A failure is logged by its error's name only and counted, never thrown: the
 * transfer sweep's work is done by then and the next sweep tries again.
 */
export async function handleCollectReminders(deps: {
  db: Database;
  sealing: MailSealing;
  log: CollectRemindersLog;
  now?: Date;
  /** Replaced in tests. */
  remind?: typeof sendCollectReminders;
}): Promise<{ reminded: number; failed: number }> {
  const remind = deps.remind ?? sendCollectReminders;
  try {
    return {
      reminded: await remind(deps.db, {
        now: deps.now ?? new Date(),
        sealing: deps.sealing,
      }),
      failed: 0,
    };
  } catch (error) {
    deps.log({
      event: 'collect_reminders.failed',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return { reminded: 0, failed: 1 };
  }
}
