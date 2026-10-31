import {
  completeDueRecoveries,
  deliverDueMail,
  purgeEmailCodes,
  requeueStuckMail,
  wipeExpiredMailContent,
  type MailDeliveryDeps,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';

const HOUSEKEEPING_MS = 60_000;

export interface MailDelivery {
  stop(): Promise<void>;
}

/**
 * Sends queued mail every `intervalMs` (20 at a time, security first). Once a minute it also
 * requeues mail a dead worker left `sending`, wipes sealed content past its 7 days and finishes
 * email recoveries whose 24-hour hold has ended. A failed
 * pass is logged by name and tried again next tick; mail waits safely in Postgres.
 */
export function startMailDelivery(options: {
  deps: Omit<MailDeliveryDeps, 'log'>;
  logger: Logger;
  intervalMs?: number;
  limit?: number;
}): MailDelivery {
  const { deps, logger, intervalMs = 500, limit = 20 } = options;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  let lastHousekeeping = 0;

  const tick = async (): Promise<void> => {
    const now = new Date();
    try {
      if (now.getTime() - lastHousekeeping >= HOUSEKEEPING_MS) {
        lastHousekeeping = now.getTime();
        await requeueStuckMail(deps.db, now);
        await wipeExpiredMailContent(deps.db, now);
        await completeDueRecoveries(deps.db, deps.sealing, now);
        await purgeEmailCodes(deps.db, now);
      }
      await deliverDueMail(
        { ...deps, log: (entry) => logger.info(entry) },
        { now, limit },
      );
    } catch (error) {
      logger.warn({
        event: 'mail.delivery_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (!stopped) timer = setTimeout(() => (running = tick()), intervalMs);
  };
  running = tick();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
