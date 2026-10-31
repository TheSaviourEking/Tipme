import type { MailProviderName } from './provider.js';

/**
 * Which provider sends one email: a test's pinned provider, else the person's override, else the
 * active provider. An override to a provider that isn't configured falls back to the active one.
 */
export function resolveMailProvider(input: {
  pinned: MailProviderName | null;
  override: MailProviderName | null;
  active: MailProviderName;
  configured: ReadonlySet<MailProviderName>;
}): MailProviderName {
  if (input.pinned) return input.pinned;
  if (input.override && input.configured.has(input.override))
    return input.override;
  return input.active;
}
