import { z } from 'zod';

/**
 * Live updates: change signals only, never data. A committed change publishes `{ to, type }` on one
 * Redis channel; the API's hub routes it by `to` and writes only `{ type }` to the browser, which then
 * re-reads its existing authorised endpoints. See docs/superpowers/specs/2026-11-03-live-updates-design.md.
 */

/**
 * Sent with `1` on a staff read that a live stream started (its ready, a resync, a signal), not the
 * person. OpsGuard then reads the grant without moving its idle clock, so an open but unused admin
 * tab still loses its grant after the idle hour (final review I1). GET only: a write always counts.
 */
export const LIVE_BACKGROUND_HEADER = 'x-tipme-background';

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
  // TipMe for businesses (plan B9 Task 23): the Business and Work pages re-read.
  'business.changed',
  // A Pro purchase left PENDING, COLLECTING or UNKNOWN, whatever the outcome (addendum §3.7):
  // Settings' "confirming" slip re-reads it. profile.changed still says when the plan changed.
  'pro.changed',
] as const;

/** Signals a staff stream may receive. */
export const LIVE_STAFF_TYPES = [
  'ops.approvals.changed',
  'ops.issues.changed',
  'ops.announcements.changed',
  'ops.providers.changed',
] as const;

/**
 * The permissions a staff target may name (addendum §4). A list means any one of them is enough:
 * the providers read route accepts either `issues.view` or `providers.manage`.
 */
export const LIVE_STAFF_PERMISSIONS = [
  'issues.view',
  'announcements.send',
  'providers.manage',
] as const;

/**
 * The one signal a tip's receipt stream may receive (addendum §3.6): "this tip changed", nothing
 * more. It goes to a `{ tip }` target only, and a `{ tip }` target carries nothing else.
 */
export const LIVE_TIP_TYPES = ['tip.changed'] as const;

/** Handled by the hub, never forwarded. */
export const LIVE_SERVER_TYPES = [
  'sessions.changed',
  'staff.changed',
  // A feature switch changed in admin: each API copy forgets its switches (docs/runbooks/settings-and-switches.md).
  'switches.changed',
] as const;

/** Written by the hub itself, never published on the channel. */
export const LIVE_CONTROL_TYPES = [
  'ready',
  'resync',
  'poll',
  'session.ended',
] as const;

export type LiveRecipientType = (typeof LIVE_RECIPIENT_TYPES)[number];
export type LiveStaffType = (typeof LIVE_STAFF_TYPES)[number];
export type LiveTipType = (typeof LIVE_TIP_TYPES)[number];
export type LiveServerType = (typeof LIVE_SERVER_TYPES)[number];
export type LiveEventType = LiveRecipientType | LiveStaffType | LiveTipType;
export type LiveControlType = (typeof LIVE_CONTROL_TYPES)[number];
export type LiveStaffPermission = (typeof LIVE_STAFF_PERMISSIONS)[number];

/** The routing key. It never leaves the server. */
export type LiveTarget =
  | { user: string }
  | { profile: string }
  | { all: true }
  | { staff: 'any' | LiveStaffPermission | readonly LiveStaffPermission[] }
  /** One tip's receipt streams, by the tip id its status token was verified for. */
  | { tip: string };

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
  z
    .object({
      staff: z.union([
        z.literal('any'),
        z.enum(LIVE_STAFF_PERMISSIONS),
        z
          .array(z.enum(LIVE_STAFF_PERMISSIONS))
          .min(1)
          .max(LIVE_STAFF_PERMISSIONS.length)
          .refine((list) => new Set(list).size === list.length),
      ]),
    })
    .strict(),
]);

const tipTargetSchema = z.object({ tip: z.string().uuid() }).strict();

/**
 * A tip target pairs with `tip.changed` only, and `tip.changed` with a tip target only (ruling
 * L-R4): the public receipt stream must not rest on every publisher being correct.
 */
export const liveMessageSchema: z.ZodType<LiveMessage> = z.union([
  z
    .object({
      to: liveTargetSchema,
      type: z.enum([
        ...LIVE_RECIPIENT_TYPES,
        ...LIVE_STAFF_TYPES,
        ...LIVE_SERVER_TYPES,
      ]),
    })
    .strict(),
  z.object({ to: tipTargetSchema, type: z.enum(LIVE_TIP_TYPES) }).strict(),
]);

/**
 * The one signal for "this person's sessions changed". Publish it after anything that ends sessions
 * commits (sign-out, revokes, an email or phone change, a recovery, account deletion): each of their
 * open streams re-checks its own session and closes with session.ended if it is gone.
 */
export const sessionsChanged = (userId: string): LiveMessage => ({
  to: { user: userId },
  type: 'sessions.changed',
});

/** Published after a feature switch changes, once the change has committed. */
export const switchesChanged: LiveMessage = {
  to: { all: true },
  type: 'switches.changed',
};

/**
 * Who holds what among staff changed, or a grant ended (admin sign-out). Never forwarded: every staff
 * stream checks its grant again and closes if it is gone or its permissions changed. Published by
 * the worker's relay and by the API, so it lives here once.
 */
export const staffChanged: LiveMessage = {
  to: { staff: 'any' },
  type: 'staff.changed',
};

/** The approvals list changed (a request was made, decided, run, cancelled or closed). Any staff stream. */
export const approvalsChanged: LiveMessage = {
  to: { staff: 'any' },
  type: 'ops.approvals.changed',
};

/** The issues inbox changed (one opened, was resolved or auto-resolved). Staff holding `issues.view`. */
export const issuesChanged: LiveMessage = {
  to: { staff: 'issues.view' },
  type: 'ops.issues.changed',
};

/** An announcement's sending progress or state changed (a batch queued, or a send was stopped). Staff holding `announcements.send`. */
export const opsAnnouncementsChanged: LiveMessage = {
  to: { staff: 'announcements.send' },
  type: 'ops.announcements.changed',
};

/**
 * A mail provider's card changed: a test email was sent or failed, a test was confirmed, or its
 * failover health changed or was cleared. Staff holding `issues.view` or `providers.manage`, the
 * two the providers read route accepts.
 */
export const opsProvidersChanged: LiveMessage = {
  to: { staff: ['issues.view', 'providers.manage'] },
  type: 'ops.providers.changed',
};

/** A Pro purchase of this page's settled (paid, failed, expired or sent for review). */
export const proChanged = (profileId: string): LiveMessage => ({
  to: { profile: profileId },
  type: 'pro.changed',
});

/**
 * A tip moved (paid, failed, still being confirmed, or cancelled as stale): its open receipts
 * re-read their status. Published by the worker's relay and expiry and by the API's webhooks.
 */
export const tipChanged = (tipId: string): LiveMessage => ({
  to: { tip: tipId },
  type: 'tip.changed',
});

/**
 * How long a browser waits before reconnecting after a copy drains its streams (a deploy). The hub
 * sends each stream a random `retry:` in this range; EventSource hides that value from the page, so
 * the browser's own client uses the same range. One constant, so the two can't drift apart.
 */
export const LIVE_DRAIN_RETRY_MS = { min: 1000, max: 10_000 } as const;

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
