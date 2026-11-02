import { sql, type SQL } from 'drizzle-orm';
import { users } from '../schema.js';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** "t•••@example.com": enough to recognise, never the whole address. */
export const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

export const normaliseEmail = (raw: string): string | null => {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
};

const GOOGLE_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
]);

/**
 * The mailbox behind an address, for telling whether two staff accounts are one person: lower case,
 * no `+tag`, and for Google no dots and one domain (the two domains are one mailbox). A comparison
 * key only: mail still goes to the address as given.
 */
export function normaliseStaffEmail(email: string): string {
  const lowered = email.trim().toLowerCase().replace(/\.+$/, '');
  const at = lowered.lastIndexOf('@');
  if (at < 0) return lowered;
  const domain = lowered.slice(at + 1);
  const local = lowered.slice(0, at).split('+')[0] || lowered.slice(0, at);
  return GOOGLE_DOMAINS.has(domain)
    ? `${local.replaceAll('.', '')}@gmail.com`
    : `${local}@${domain}`;
}

/**
 * The value for users.email_changed_at when `email` is being written. Every write of a sign-in
 * address uses this: confirming the address already proven on the account is not a change.
 */
export const emailChangedAtFor = (email: string, now: Date): SQL<Date> =>
  sql<Date>`CASE WHEN lower(${users.email}) = ${email.toLowerCase()} AND ${users.emailVerifiedAt} IS NOT NULL
    THEN ${users.emailChangedAt} ELSE ${now.toISOString()}::timestamptz END`;
