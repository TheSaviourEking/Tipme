import type { MailProviderName } from './provider.js';

/** Top-level domains reserved for testing and documentation (RFC 2606): never deliverable. */
const RESERVED = ['example', 'test', 'invalid', 'localhost'];

/**
 * Whether an address can never receive mail: a reserved test domain, or one of `domains` (a
 * copy's own test domains, such as the release check's staff address) or a subdomain of one.
 */
export function isPretendRecipient(
  address: string,
  domains: readonly string[],
): boolean {
  const at = address.lastIndexOf('@');
  if (at < 1) return false;
  const domain = address.slice(at + 1).toLowerCase();
  const tld = domain.split('.').at(-1) ?? '';
  if (RESERVED.includes(tld)) return true;
  return domains.some((d) => {
    const own = d.trim().toLowerCase();
    return own !== '' && (domain === own || domain.endsWith(`.${own}`));
  });
}

/**
 * Which provider sends one email: a test's pinned provider, else the pretend inbox for an
 * address that can never receive mail (only where a pretend provider exists, never production),
 * else the person's override, else the active provider. An override to a provider that isn't
 * configured falls back to the active one.
 */
export function resolveMailProvider(input: {
  pinned: MailProviderName | null;
  override: MailProviderName | null;
  active: MailProviderName;
  configured: ReadonlySet<MailProviderName>;
  /** The recipient, for the pretend-inbox rule; omitted, the rule doesn't apply. */
  to?: string;
  pretendDomains?: readonly string[];
}): MailProviderName {
  if (input.pinned) return input.pinned;
  if (
    input.to &&
    input.configured.has('mock') &&
    isPretendRecipient(input.to, input.pretendDomains ?? [])
  )
    return 'mock';
  if (input.override && input.configured.has(input.override))
    return input.override;
  return input.active;
}
