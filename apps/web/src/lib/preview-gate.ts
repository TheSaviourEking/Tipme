import { validPreviewTicket } from '@tipme/domain';

// Staging/preview (PR-010): the same signed ticket as the API's gate, set by /preview-login.
export const PREVIEW_COOKIE = '__Secure-tipme_preview';

// Open without the password: the login page itself, the API's cache refresh (its own secret) and
// a few files every browser asks for. Anything unusual in the path is never treated as open.
const OPEN = [
  /^\/preview-login$/,
  /^\/api\/revalidate$/,
  /^\/(favicon\.ico|robots\.txt|icon\.svg)$/,
];

export function gateDecision(input: {
  path: string;
  ticket: string | undefined;
  password: string;
  now?: number;
}): 'pass' | 'login' | 'exempt' {
  const plain = !/\/\/|%|\.\.|\\/.test(input.path);
  if (plain && OPEN.some((p) => p.test(input.path))) return 'exempt';
  return validPreviewTicket(
    input.ticket,
    input.password,
    input.now ?? Date.now(),
  )
    ? 'pass'
    : 'login';
}

/** Where to go after signing in: only a path on this site. */
export function safeReturnPath(value: string | null | undefined): string {
  // Browsers drop tabs and newlines from a Location header, so "/\t/evil.com" would become
  // "//evil.com": refuse any whitespace or control character outright.
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  )
    return '/';
  return value;
}
