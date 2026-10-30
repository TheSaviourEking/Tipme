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

export interface MailType<T> {
  id: string;
  category: MailCategory;
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
