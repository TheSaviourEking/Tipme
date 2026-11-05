import { z } from 'zod';

/**
 * Live updates: change signals only, never data. A committed change publishes `{ to, type }` on one
 * Redis channel; the API's hub routes it by `to` and writes only `{ type }` to the browser, which then
 * re-reads its existing authorised endpoints. See docs/superpowers/specs/2026-11-03-live-updates-design.md.
 */

/** Signals a recipient's stream may receive. */
export const LIVE_RECIPIENT_TYPES = [
  'tips.changed',
  'notifications.changed',
  'moments.changed',
  'withdrawals.changed',
  'payments.changed',
  'profile.changed',
  'reports.changed',
  'account.changed',
] as const;

/** Signals a staff stream may receive. */
export const LIVE_STAFF_TYPES = [
  'ops.approvals.changed',
  'ops.issues.changed',
] as const;

/** Handled by the hub, never forwarded. */
export const LIVE_SERVER_TYPES = ['sessions.changed', 'staff.changed'] as const;

/** Written by the hub itself, never published on the channel. */
export const LIVE_CONTROL_TYPES = [
  'ready',
  'resync',
  'poll',
  'session.ended',
] as const;

export type LiveRecipientType = (typeof LIVE_RECIPIENT_TYPES)[number];
export type LiveStaffType = (typeof LIVE_STAFF_TYPES)[number];
export type LiveServerType = (typeof LIVE_SERVER_TYPES)[number];
export type LiveEventType = LiveRecipientType | LiveStaffType;
export type LiveControlType = (typeof LIVE_CONTROL_TYPES)[number];

/** The routing key. It never leaves the server. */
export type LiveTarget =
  | { user: string }
  | { profile: string }
  | { all: true }
  | { staff: 'any' | 'issues.view' };

export interface LiveMessage {
  to: LiveTarget;
  type: LiveEventType | LiveServerType;
}

/** The only shape a browser ever receives. */
export interface LiveBrowserMessage {
  type: LiveEventType | LiveControlType;
}

const liveTargetSchema = z.union([
  z.object({ user: z.string().uuid() }).strict(),
  z.object({ profile: z.string().uuid() }).strict(),
  z.object({ all: z.literal(true) }).strict(),
  z.object({ staff: z.enum(['any', 'issues.view']) }).strict(),
]);

export const liveMessageSchema: z.ZodType<LiveMessage> = z
  .object({
    to: liveTargetSchema,
    type: z.enum([
      ...LIVE_RECIPIENT_TYPES,
      ...LIVE_STAFF_TYPES,
      ...LIVE_SERVER_TYPES,
    ]),
  })
  .strict();

/**
 * The one signal for "this person's sessions changed". Publish it after anything that ends sessions
 * commits (sign-out, revokes, an email or phone change, a recovery, account deletion): each of their
 * open streams re-checks its own session and closes with session.ended if it is gone.
 */
export const sessionsChanged = (userId: string): LiveMessage => ({
  to: { user: userId },
  type: 'sessions.changed',
});

export const liveChannel = (queuePrefix: string): string =>
  `${queuePrefix}:live:v1`;

/** Parses one channel message. Never throws: anything malformed is `null`. */
export function parseLiveMessage(raw: string): LiveMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = liveMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
