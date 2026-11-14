// Business sign-up, Task D3: which path the sign-up card opens on. Pure: unit tests load it.
import { handleFromSearch } from './handle-hint.ts';

export type SignUpPath = 'ask' | 'tipped' | 'business' | 'join';

/**
 * An invitation link (`#join=`) skips the question, since staff always get a handle; a link
 * carrying `?for=business` (home's line, the header, /for-businesses) picks "For businesses"; the
 * home claim field's handle picks "Get tipped". Anything else asks.
 */
export function signUpPath(search: string, hash: string): SignUpPath {
  if (hash.startsWith('#join=')) return 'join';
  if (new URLSearchParams(search).get('for') === 'business') return 'business';
  if (handleFromSearch(search)) return 'tipped';
  return 'ask';
}
