import { PAYOUT_START_EVENT, WITHDRAWALS_SWITCH_EVENT } from '@tipme/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { payouts, withdrawalsSwitch } from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { enqueueOutbox } from './outbox.js';

export interface WithdrawalsSwitchState {
  paused: boolean;
  changedAt: Date | null;
}

/** The switch as it stands. No row is on. A failed read throws: callers must not read that as on. */
export function withdrawalsSwitchState(
  db: Database | Tx,
): Promise<WithdrawalsSwitchState> {
  return guarded(async () => {
    const [row] = await db
      .select({
        paused: withdrawalsSwitch.paused,
        changedAt: withdrawalsSwitch.changedAt,
      })
      .from(withdrawalsSwitch);
    return row ?? { paused: false, changedAt: null };
  });
}

/** For what is only shown: a switch that can't be read counts as off, so nothing promises money. */
export async function withdrawalsSwitchedOff(db: Database): Promise<boolean> {
  try {
    return (await withdrawalsSwitchState(db)).paused;
  } catch {
    return true;
  }
}

/**
 * Staff switch all withdrawals off or on. It takes effect at the next request or job, on every copy,
 * since each reads this row. Off stops new requests and starts only: payouts already with the
 * provider can't be recalled, and carry on being tracked. Queued payouts stay reserved and are
 * queued again here when it comes back on, except those a person must decide on (an open issue, or a
 * hold, whose own job check would stop them anyway). Setting the state it already has changes nothing.
 */
export function setWithdrawalsPaused(
  db: Database,
  input: {
    paused: boolean;
    staffUserId: string;
    reason: string;
    now?: Date;
  },
): Promise<{ changed: boolean }> {
  const now = input.now ?? new Date();
  return guarded(() =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('withdrawals_switch'))`,
      );
      const { paused } = await withdrawalsSwitchState(tx);
      if (paused === input.paused) return { changed: false };
      const values = {
        paused: input.paused,
        changedBy: input.staffUserId,
        changedAt: now,
      };
      await tx
        .insert(withdrawalsSwitch)
        .values({ id: 'global', ...values })
        .onConflictDoUpdate({ target: withdrawalsSwitch.id, set: values });
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: input.paused
          ? 'withdrawals.switched_off'
          : 'withdrawals.switched_on',
        permission: 'payouts.resolve',
        subjectType: 'withdrawals_switch',
        subjectId: 'global',
        reason: input.reason,
        now,
      });
      const change = newId();
      // The written reason stays in the audit log: the alert route is a chat room.
      await enqueueOutbox(tx, {
        eventType: WITHDRAWALS_SWITCH_EVENT,
        aggregateId: change,
        payload: { state: input.paused ? 'off' : 'on' },
      });
      if (!input.paused) {
        const waiting = await tx
          .select({ id: payouts.id, profileId: payouts.profileId })
          .from(payouts)
          .where(
            and(
              eq(payouts.status, 'REQUESTED'),
              isNull(payouts.providerReference),
              isNull(payouts.startStep),
              isNull(payouts.startUncertainAt),
              sql`NOT EXISTS (
                SELECT 1 FROM issues i
                 WHERE i.status = 'open'
                   AND i.subject->>'payoutId' = ${payouts.id}::text)`,
              sql`NOT EXISTS (
                SELECT 1 FROM withdrawal_holds h
                 WHERE h.profile_id = ${payouts.profileId}
                   AND h.released_at IS NULL)`,
            ),
          );
        for (const payout of waiting)
          await enqueueOutbox(tx, {
            eventType: PAYOUT_START_EVENT,
            aggregateId: payout.id,
            dedupeSuffix: `switch.${change}`,
            payload: { payoutId: payout.id, profileId: payout.profileId },
          });
      }
      return { changed: true };
    }),
  );
}
