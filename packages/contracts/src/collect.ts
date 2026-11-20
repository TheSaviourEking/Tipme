import { z } from 'zod';
import { opsReasonSchema } from './ops.js';

/**
 * You collect (ADR-0016, PROPOSED; spec §2, §8, §9): TipMe takes a new recipient's tips on its own
 * account and holds each share until they add bank details. Amounts are decimal strings of minor
 * units; the server is the only source of them.
 */

/**
 * A recipient's You collect state (plan Task 12; read by `GET /v1/me/collect`, Task 13). `heldMinor`
 * is what TipMe holds for them now; `onItsWayMinor` is the part already on its way (they are
 * verified), never withdrawable yet. The page pauses at the holding cap (`pausedReason`) until they
 * are verified; `pauseOn` is when the days part of the cap is reached. The two withdrawal limits are
 * null when they don't apply (a direct recipient, a first withdrawal already made, an older account).
 */
export interface CollectStatus {
  mode: 'direct' | 'collect';
  verified: boolean;
  heldMinor: string;
  onItsWayMinor: string;
  firstWaitingAt: string | null;
  paused: boolean;
  pausedReason: 'amount' | 'days' | null;
  pauseOn: string | null;
  firstWithdrawalCapMinor: string | null;
  dailyLimitMinor: string | null;
}

/** The settings as staff read and send them (spec §9). */
export interface OpsCollectSettingsValues {
  /** The holding cap: the most held for one recipient without bank details. */
  capMinor: string;
  capDays: number;
  /** Days after the first waiting tip on which the recipient is reminded, ascending. */
  reminderDays: number[];
  /** The new-recipient delay: hours each share waits, for this many days after sign-up. */
  delayHours: number;
  delayForDays: number;
  firstWithdrawalCapMinor: string;
  /** A new account's limit per Lagos day, for this many days after sign-up. */
  newDailyLimitMinor: string;
  newDailyLimitDays: number;
  /** TipMe's own money above what it holds for recipients: alert levels, critical below warning. */
  reserveWarningMinor: string;
  reserveCriticalMinor: string;
}

export interface OpsCollectSettingsRow extends OpsCollectSettingsValues {
  id: string;
  paused: boolean;
  effectiveFrom: string;
  setBy: string | null;
  approvedBy: string | null;
  reason: string;
  createdAt: string;
}

/**
 * `GET /v1/ops/collect-settings`: the settings in force (a stored row, or the coded defaults), their
 * history, the minimum withdrawal (the floor of the first-withdrawal cap), and a change, pause or
 * resume still waiting for a second person.
 */
export interface OpsCollectSettings {
  current: OpsCollectSettingsValues & {
    /** Staff paused every collect transfer (R11). */
    paused: boolean;
    source: 'setting' | 'default';
    effectiveFrom: string | null;
  };
  history: OpsCollectSettingsRow[];
  minWithdrawalMinor: string;
  waitingRequestId: string | null;
}

const minor = z.string().regex(/^(0|[1-9][0-9]{0,11})$/);
const days = z.number().int().min(0).max(365);

/**
 * `POST /v1/ops/collect-settings`: the whole set, with a reason. The shape is checked here; the
 * bounds (§9), critical below warning, each reminder before the cap's last day and the first cap at
 * least the minimum withdrawal are the server's, in the serious action.
 */
export const opsCollectSettingsChangeSchema = opsReasonSchema
  .extend({
    capMinor: minor,
    capDays: days,
    reminderDays: z.array(days).min(1).max(10),
    delayHours: days,
    delayForDays: days,
    firstWithdrawalCapMinor: minor,
    newDailyLimitMinor: minor,
    newDailyLimitDays: days,
    reserveWarningMinor: minor,
    reserveCriticalMinor: minor,
  })
  .strict();
export type OpsCollectSettingsChangeRequest = z.infer<
  typeof opsCollectSettingsChangeSchema
>;
