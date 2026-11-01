import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { livePaymentSwitches } from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';

export interface LiveSwitch {
  live: boolean;
  provider: string;
  version: string;
  switchedAt: Date;
}

// As the index is defined; a bare DESC would not use it.
const LATEST = [
  sql`${livePaymentSwitches.switchedAt} DESC NULLS LAST`,
  sql`${livePaymentSwitches.id} DESC NULLS LAST`,
] as const;

/** The latest change of live payments on this copy, or null if they were never switched on. */
export function currentLiveSwitch(db: Database): Promise<LiveSwitch | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        live: livePaymentSwitches.live,
        provider: livePaymentSwitches.provider,
        version: livePaymentSwitches.version,
        switchedAt: livePaymentSwitches.switchedAt,
      })
      .from(livePaymentSwitches)
      .orderBy(...LATEST)
      .limit(1);
    return row ?? null;
  });
}

/**
 * Records that live payments changed, if they did. A copy with no row has never been on, so booting
 * closed records nothing; only a change does, whichever version or provider carries it. Copies
 * booting together take turns on an advisory lock held for this short transaction, so the first
 * records the change and the others find it already there.
 */
export function recordLiveSwitch(
  db: Database,
  input: {
    live: boolean;
    provider: string;
    version: string;
    now?: Date;
  },
): Promise<'recorded' | 'unchanged'> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('live_payment_switches'))`,
      );
      const [latest] = await tx
        .select({ live: livePaymentSwitches.live })
        .from(livePaymentSwitches)
        .orderBy(...LATEST)
        .limit(1);
      if ((latest?.live ?? false) === input.live) return 'unchanged';
      const id = newId();
      const switchedAt = input.now ?? new Date();
      await tx.insert(livePaymentSwitches).values({
        id,
        live: input.live,
        provider: input.provider,
        version: input.version,
        switchedAt,
      });
      // The audit log can't be edited, which the table above can. The env file, not a person in
      // the app, makes this change, so the actor is the system.
      await recordAudit(tx, {
        staffUserId: null,
        action: input.live ? 'payments.live_on' : 'payments.live_off',
        subjectType: 'live_payment_switch',
        subjectId: id,
        reason: `Started as ${input.provider}, version ${input.version}.`,
        now: switchedAt,
      });
      return 'recorded';
    }),
  );
}
