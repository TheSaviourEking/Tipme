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
