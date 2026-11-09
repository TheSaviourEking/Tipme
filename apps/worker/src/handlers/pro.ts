import type { LiveMessage } from '@tipme/contracts';
import {
  expireDuePeriods,
  sendProReminders,
  type Database,
  type MailSealing,
} from '@tipme/database';
import { setTimeout as sleep } from 'node:timers/promises';

/** Revalidating is best effort: the sweep's work has committed, and a slow web app can't hold the job. */
const REVALIDATE_WITHIN_MS = 10_000;

/**
 * The `pro.expire` job, every minute (ADR-0015): moves paid Pro months on (queued → active →
 * grace → ended), then tells the web app and the owner's open tabs about every page whose plan
 * changed. Run twice at once, the second finds nothing to do: each profile is swept under its lock.
 */
export async function handleProExpire(deps: {
  db: Database;
  sealing: MailSealing;
  now: () => Date;
  /** Null when no revalidation secret is set. */
  revalidate: ((handle: string) => Promise<void>) | null;
  publishLive: (messages: LiveMessage[]) => Promise<void>;
  revalidateWithinMs?: number;
  log?: (entry: Record<string, unknown>) => void;
  /** For tests: the sweep itself has its own integration tests. */
  expire?: typeof expireDuePeriods;
}): Promise<'swept'> {
  const result = await (deps.expire ?? expireDuePeriods)(deps.db, {
    now: deps.now(),
    sealing: deps.sealing,
  });
  deps.log?.({
    event: 'pro.expire_swept',
    moved: result.moved,
    changed: result.changed.length,
  });
  if (result.changed.length === 0) return 'swept';
  await deps.publishLive(
    result.changed.map((page) => ({
      to: { profile: page.profileId },
      type: 'profile.changed' as const,
    })),
  );
  const revalidate = deps.revalidate;
  if (revalidate) {
    const all = Promise.allSettled(
      result.changed.map((page) => revalidate(page.handleLower)),
    );
    const outcome = await Promise.race([
      all.then(() => 'done' as const),
      sleep(deps.revalidateWithinMs ?? REVALIDATE_WITHIN_MS, 'late' as const, {
        ref: false,
      }),
    ]);
    if (outcome === 'late') deps.log?.({ event: 'pro.expire_revalidate_late' });
  }
  return 'swept';
}

/** The `pro.reminders` job, every 15 minutes: 7-day and 1-day renewal reminders, once each. */
export async function handleProReminders(deps: {
  db: Database;
  sealing: MailSealing;
  now: () => Date;
  log?: (entry: Record<string, unknown>) => void;
  remind?: typeof sendProReminders;
}): Promise<'reminded'> {
  const { queued } = await (deps.remind ?? sendProReminders)(deps.db, {
    now: deps.now(),
    sealing: deps.sealing,
  });
  deps.log?.({ event: 'pro.reminders_sent', queued });
  return 'reminded';
}
