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

/**
 * The providers one email may try, in order (automatic failover, owner 23 Nov 2026): the provider
 * resolveMailProvider picks, then the backup. The failover group is the server default plus
 * MAIL_FALLBACK_PROVIDERS, so the backup is whichever of them isn't active: ZeptoMail active, Brevo
 * is the backup; staff make Brevo active, ZeptoMail is. Only the one provider, as before, for a
 * provider test, a per-person override, the pretend inbox, a provider staff fixed in ops, or with
 * no fallback list. The pretend provider is never a fallback in production. `after` (a code asked
 * for again) starts the list after the provider that sent the previous one.
 */
export function mailProviderChain(input: {
  pinned: MailProviderName | null;
  override: MailProviderName | null;
  active: MailProviderName;
  /** MAIL_DEFAULT_PROVIDER: the backup when staff made a fallback active. */
  defaultProvider: MailProviderName;
  configured: ReadonlySet<MailProviderName>;
  to?: string;
  pretendDomains?: readonly string[];
  /** MAIL_FALLBACK_PROVIDERS, in order; empty keeps today's single provider. */
  fallbacks: readonly MailProviderName[];
  production: boolean;
  /** Staff fixed the active provider in ops: no automatic switching. */
  fixed?: boolean;
  /** The provider that sent the previous code to this address (a resend). */
  after?: MailProviderName | null;
}): MailProviderName[] {
  const first = resolveMailProvider(input);
  const pretend =
    input.to !== undefined &&
    input.configured.has('mock') &&
    isPretendRecipient(input.to, input.pretendDomains ?? []);
  const overridden =
    input.override !== null && input.configured.has(input.override);
  if (
    input.fallbacks.length === 0 ||
    input.pinned ||
    pretend ||
    overridden ||
    input.fixed
  )
    return [first];
  const chain: MailProviderName[] = [first];
  for (const name of [input.defaultProvider, ...input.fallbacks])
    if (
      !chain.includes(name) &&
      input.configured.has(name) &&
      !(input.production && name === 'mock')
    )
      chain.push(name);
  const at = input.after ? chain.indexOf(input.after) : -1;
  return at < 0 || chain.length < 2
    ? chain
    : [...chain.slice(at + 1), ...chain.slice(0, at + 1)];
}

/**
 * The providers that stand in for each other (automatic failover): the server default, then
 * MAIL_FALLBACK_PROVIDERS, configured ones only, never the pretend provider in production. The
 * backup of one is the first other provider here.
 */
export function mailFailoverGroup(
  defaultProvider: MailProviderName,
  fallbacks: readonly MailProviderName[],
  configured: ReadonlySet<MailProviderName>,
  production: boolean,
): MailProviderName[] {
  const group: MailProviderName[] = [];
  for (const name of [defaultProvider, ...fallbacks])
    if (
      !group.includes(name) &&
      configured.has(name) &&
      !(production && name === 'mock')
    )
      group.push(name);
  return group;
}
