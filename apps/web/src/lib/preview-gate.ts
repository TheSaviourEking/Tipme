import { validPreviewTicket } from '@tipme/domain';

// Staging/preview (PR-010): the same signed ticket as the API's gate, set by /preview-login.
export const PREVIEW_COOKIE = '__Secure-tipme_preview';

// Open without the password: the login page itself, the API's cache refresh (its own secret), the
// build id and a few files every browser asks for. Anything unusual in the path is never treated as open.
const OPEN = [
  /^\/preview-login$/,
  /^\/api\/revalidate$/,
  // The build id only (the API's /health/release shows it publicly): the edge's health check and
  // the deploy's version check have no ticket.
  /^\/api\/version$/,
  /^\/(favicon\.ico|robots\.txt)$/,
  // The tab, home-screen and Apple icons and their manifest, exact names only.
  /^\/(manifest\.webmanifest|icons\/(favicon-(32|48)|apple-touch-icon|192|512-maskable)\.png)$/,
  // The logo every email loads (packages/mail layout.ts); mail clients have no ticket.
  // The old names stay for emails already sent (they ask for them at 120 x 45).
  /^\/email\/tipme-logo-(2026-)?(light|dark)-(2x|3x)\.png$/,
  // Pictures from public/ (the repository's own files): self-hosted, Next's image optimiser
  // fetches them from this server with no headers, so with no ticket (26 Nov 2026).
  /^\/(brand|covers|illustrations|portraits|pro)\/([\w-]+\/)*[\w.-]+\.(png|webp|jpe?g|avif|svg)$/,
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
