import type { z } from 'zod';

/** Decides whether a person can turn an email off (spec §6). */
export type MailCategory =
  'security' | 'account' | 'transactional' | 'engagement' | 'marketing';

export const MAIL_CATEGORIES: readonly MailCategory[] = [
  'security',
  'account',
  'transactional',
  'engagement',
  'marketing',
];

export interface MailContext {
  webOrigin: string;
  /** Set for toggleable mail (Part 7); null hides the settings link. */
  unsubscribeUrl: string | null;
  /** Rendering the stored snapshot: personal links become "[personal link]". */
  redact?: boolean;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

/** A per-type switch on the recipient's profile, or null when the type has none. */
export type MailPreference =
  'notify_tip_emails' | 'notify_weekly_reports' | 'notify_milestones';

/**
 * Who an email comes from: a name on the mail domain (no inbox; replies go to support). New
 * senders are added here; receipts, business and news are reserved for what comes next.
 */
export const MAIL_SENDERS = {
  security: { local: 'security', label: 'Security' },
  notifications: { local: 'notifications', label: 'Notifications' },
  payments: { local: 'payments', label: 'Payments' },
  reports: { local: 'reports', label: 'Reports' },
  hello: { local: 'hello', label: null },
  legal: { local: 'legal', label: 'Legal' },
  system: { local: 'system', label: null },
  receipts: { local: 'receipts', label: 'Receipts' },
  business: { local: 'business', label: 'Business' },
  news: { local: 'news', label: 'News' },
} as const;

export type MailSender = keyof typeof MAIL_SENDERS;

/** `security` on staging-mail.usetipme.xyz → "TipMe Staging Security <security@…>". */
export function senderAddress(
  sender: MailSender,
  brand: {
    domain: string;
    name: string;
    /** One address for every sender, e.g. while the mail domain awaits verification. */
    address?: string | undefined;
  },
): { address: string; name: string } {
  const { local, label } = MAIL_SENDERS[sender];
  return {
    address: brand.address ?? `${local}@${brand.domain}`,
    name: label ? `${brand.name} ${label}` : brand.name,
  };
}

export interface MailType<T> {
  id: string;
  category: MailCategory;
  sender: MailSender;
  schema: z.ZodType<T>;
  preference: MailPreference | null;
  /** Opens and clicks are tracked; always false for security mail. */
  tracking: boolean;
  render(data: T, ctx: MailContext): RenderedMail;
  /** Realistic data for tests and previews. */
  sample: T;
}

export function defineMailType<T>(
  type: Omit<MailType<T>, 'tracking'> & { tracking?: boolean },
): MailType<T> {
  return {
    ...type,
    // Never a tracking pixel or rewritten link next to a code (spec §2).
    tracking: type.category === 'security' ? false : (type.tracking ?? true),
  };
}

/**
 * A link into TipMe that says which link was clicked (`ml`), so click events name the link and
 * never carry its URL. A personal link (one-time token) is redacted in the stored snapshot.
 */
export function mailLink(
  ctx: MailContext,
  path: string,
  linkKey: string,
  personal = false,
): string {
  if (personal && ctx.redact) return '[personal link]';
  const url = new URL(path, ctx.webOrigin);
  url.searchParams.set('ml', linkKey);
  return url.toString();
}
