import { z } from 'zod';

// Anonymous first-party analytics (PR-009, ADR-0010). A strict allow-list: no free text, no ids
// that link visits together, nothing that names a person. Off in production until D-07.

/** Events a browser may send. */
export const ANALYTICS_CLIENT_EVENTS = [
  'profile_viewed',
  'tip_cta_clicked',
  'amount_selected',
  'custom_amount_entered',
  'message_started',
  'payment_started',
  'qr_scanned',
  'recipient_shared_link',
  'qr_downloaded',
  'qr_printed',
  'report_shared',
  'moment_shared',
  'recipient_returned',
] as const;
/** Outcomes recorded only from verified server state, never from a browser. */
export const ANALYTICS_SERVER_EVENTS = [
  'payment_pending',
  'payment_failed',
  'tip_completed',
  'recipient_first_tip',
] as const;
export const ANALYTICS_SURFACES = [
  'profile',
  'checkout',
  'status',
  'dashboard',
  'qr',
  'report',
  'moments',
] as const;
export const ANALYTICS_CHANNELS = [
  'qr',
  'link',
  'instagram',
  'x',
  'facebook',
  'whatsapp',
  'search',
  'direct',
  'other',
] as const;

export type AnalyticsClientEvent = (typeof ANALYTICS_CLIENT_EVENTS)[number];
export type AnalyticsServerEvent = (typeof ANALYTICS_SERVER_EVENTS)[number];
export type AnalyticsChannel = (typeof ANALYTICS_CHANNELS)[number];
export type AnalyticsSurface = (typeof ANALYTICS_SURFACES)[number];

export const analyticsEventSchema = z
  .object({
    name: z.enum(ANALYTICS_CLIENT_EVENTS),
    // Random per browser tab session; never stored across sessions or joined to an account.
    flowId: z.uuid(),
    surface: z.enum(ANALYTICS_SURFACES).optional(),
    channel: z.enum(ANALYTICS_CHANNELS).optional(),
    // A public handle; the server keeps it only if such a page exists.
    handle: z
      .string()
      .regex(/^[A-Za-z0-9_]{3,30}$/)
      .optional(),
    // "Has this browser visited TipMe before": a yes/no flag, no identifier.
    returning: z.boolean().optional(),
  })
  .strict();
export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

// Real-user web vitals (PR-011, PRD §10.1): a metric, its value and the kind of page. No URL,
// handle, flow id or anything else that could tell visits apart.
export const WEB_VITAL_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export const WEB_VITAL_PAGES = [
  'home',
  'marketing',
  'profile',
  'checkout',
  'status',
  'dashboard',
  'account',
] as const;
export type WebVitalMetric = (typeof WEB_VITAL_METRICS)[number];
export type WebVitalPage = (typeof WEB_VITAL_PAGES)[number];

/** PRD §10.1 p75 budgets (milliseconds; CLS is unitless). FCP and TTFB are shown without one. */
export const WEB_VITAL_BUDGETS: Partial<Record<WebVitalMetric, number>> = {
  LCP: 2000,
  INP: 150,
  CLS: 0.05,
};

export const webVitalSchema = z
  .object({
    metric: z.enum(WEB_VITAL_METRICS),
    // Milliseconds up to 10 minutes; CLS (unitless) up to 10.
    value: z.number().finite().min(0).max(600_000),
    page: z.enum(WEB_VITAL_PAGES),
  })
  .strict()
  .refine((vital) => vital.metric !== 'CLS' || vital.value <= 10, {
    path: ['value'],
  });
export type WebVital = z.infer<typeof webVitalSchema>;

export interface WebVitalSummary {
  metric: WebVitalMetric;
  /** p75 over mobile visits in the last 28 days; null without samples. */
  p75: number | null;
  samples: number;
  budget: number | null;
  withinBudget: boolean | null;
}
