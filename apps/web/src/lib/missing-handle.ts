import { normaliseHandle } from '@tipme/domain';

/**
 * The handle in a missing `/@handle/...` address, in the form the profile route uses, or null.
 * Anything that is not a valid handle is never shown back to the visitor.
 */
export function missingHandle(pathname: string | null): string | null {
  const match = /^\/@([^/]+)/.exec(pathname ?? '');
  if (!match?.[1]) return null;
  try {
    return normaliseHandle(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}
