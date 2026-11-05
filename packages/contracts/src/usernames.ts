import { z } from 'zod';
import type { OpsPage } from './ops.js';

/**
 * Staff reserve and release usernames from /ops (permission `usernames.manage`). The server folds
 * the name into its reservation key (case and '-'/'_' alike), so `name` is whatever staff typed;
 * the reason is checked like every staff reason (10 to 500 characters). Release takes the shared
 * `opsReasonSchema` body.
 */
export const opsUsernameReserveSchema = z
  .object({ name: z.string().min(1).max(40), reason: z.string() })
  .strict();
export type OpsUsernameReserveRequest = z.infer<
  typeof opsUsernameReserveSchema
>;

export const opsUsernamesQuerySchema = z
  .object({
    q: z.string().max(30).optional(),
    state: z.enum(['staff', 'take_back']).optional(),
  })
  .strict();
export type OpsUsernamesQuery = z.infer<typeof opsUsernamesQuerySchema>;

export interface OpsReservation {
  id: string;
  /** The reservation key: lower case, '_' for '-'. */
  name: string;
  source: 'staff' | 'take_back';
  reason: string;
  /** Masked staff email; null when the system completed a take-back. */
  reservedBy: string | null;
  reservedAt: string;
  takeBackId: string | null;
}

/** What a name is right now, for staff deciding what to do with it. */
export type OpsUsernameCheck =
  | { name: string; state: 'invalid' }
  | { name: string; state: 'built_in' }
  /** heldUntil: a deleted page's 90-day hold; a reservation simply outlasts it. */
  | { name: string; state: 'free'; heldUntil: string | null }
  | { name: string; state: 'reserved'; reservation: OpsReservation }
  /** Public-level page fields only: no email, phone or balance. */
  | { name: string; state: 'page'; kind: 'current' | 'old'; page: OpsPage };

export interface OpsUsernamesList {
  /** The newest 200 that match, newest first. */
  reservations: OpsReservation[];
  /** More match than are shown: narrow by the start of the name to find them. */
  more: boolean;
  /** TipMe's own list, in code; never released from /ops. */
  builtIn: readonly string[];
}

/* Take-backs (username reservation spec, sections 3.3 and 12) */

export const TAKE_BACK_CATEGORIES = [
  'ordinary',
  'impersonation',
  'trademark',
  'legal',
] as const;
export type TakeBackCategory = (typeof TAKE_BACK_CATEGORIES)[number];
export type TakeBackKind = 'current' | 'old';
export type TakeBackState =
  'approved' | 'noticed' | 'due' | 'done' | 'cancelled';
export type TakeBackOutcome =
  'user_chose' | 'assigned' | 'page_deleted' | 'old_removed';
export type TakeBackNoticedVia = 'email' | 'banner' | 'unreached';

/** The fixed "why" per category (owner answer 3). Shown to the user verbatim; never staff text. */
export const TAKE_BACK_WHY: Record<TakeBackCategory, string> = {
  ordinary:
    'We need it to protect a brand, a public figure or one of our own names.',
  impersonation: 'The username impersonates someone.',
  trademark: 'The username infringes a trademark.',
  legal: 'The law requires us to change it.',
};

export const TAKE_BACK_CATEGORY_WORDS: Record<TakeBackCategory, string> = {
  ordinary: 'Ordinary',
  impersonation: 'Impersonation',
  trademark: 'Trademark',
  legal: 'Required by law',
};

/** With neither a sent email nor a seen banner, the take-back goes ahead after this (owner answer 2). */
export const TAKE_BACK_NEVER_REACHED_MS = 14 * 86_400_000;
/** One free change of an assigned username, within this long (owner answer 4). */
export const TAKE_BACK_FREE_CHANGE_MS = 30 * 86_400_000;
/** The reminder goes this long before the deadline, only when notice_days >= 4. */
export const TAKE_BACK_REMINDER_MS = 2 * 86_400_000;
