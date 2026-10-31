/**
 * Provider identifiers are opaque (Bachs documents no fixed prefix): 1–200 characters without
 * whitespace, control characters, `/` or `:` (TipMe joins account and checkout with `:`).
 */
export const OPAQUE_PROVIDER_ID = /^[^\s:/\u0000-\u001f\u007f]{1,200}$/;

/** `<account>:<checkout>`, each part opaque. */
export function isScopedProviderReference(value: string): boolean {
  const separator = value.indexOf(':');
  return (
    separator > 0 &&
    OPAQUE_PROVIDER_ID.test(value.slice(0, separator)) &&
    OPAQUE_PROVIDER_ID.test(value.slice(separator + 1))
  );
}
