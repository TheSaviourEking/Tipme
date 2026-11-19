import { STUDIO_EMBED_ORIGINS } from '@tipme/contracts';

/**
 * The public page's path before the rewrite (next.config.ts), where a Page Studio video may open
 * a frame. Headers match the address the browser asked for. Campaign pages (/@username/<ending>)
 * show the standard page, so they keep the site-wide policy.
 */
export const PUBLIC_PAGE_SOURCE = '/@:handle';

/**
 * Page Studio's preview document (styles plan Task 12): the editor draws the person's page in a
 * frame of this one route, so each style's layout follows the preview's width. Only this site may
 * frame it (`frame-ancestors 'self'`, SAMEORIGIN); every other page still refuses all framing.
 */
export const STUDIO_PREVIEW_SOURCE = '/studio-preview';

/**
 * The Content-Security-Policy. Inline scripts/styles are required by statically rendered Next.js
 * pages (nonces would force dynamic rendering; deferred, threat model X1); every other resource
 * class is restricted, and the browser may reach only this site and the configured API origin.
 *
 * `frames`: the public page only. A Page Studio video is a frame from one of STUDIO_EMBED_ORIGINS,
 * loaded when the visitor taps play (plan Task 8). Everywhere else frame-src is absent, so it falls
 * back to default-src 'self'.
 */
export function contentSecurityPolicy({
  apiOrigin,
  dev,
  frames,
  framedBySelf = false,
}: {
  apiOrigin: string;
  dev: boolean;
  frames: boolean;
  /** The Studio preview only: this site may frame it. */
  framedBySelf?: boolean;
}): string {
  return [
    "default-src 'self'",
    // React's development build needs eval() for its debugging tools; production never does.
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // Uploaded profile and Studio photos are served by the API (/v1/avatars/..., /v1/studio-images/...).
    `img-src 'self' data: blob: ${apiOrigin}`,
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}`,
    "media-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    ...(frames ? [`frame-src ${STUDIO_EMBED_ORIGINS.join(' ')}`] : []),
    `frame-ancestors ${framedBySelf ? "'self'" : "'none'"}`,
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** Every response's security headers; `frames` and `framedBySelf` as in contentSecurityPolicy. */
export function securityHeaders(options: {
  apiOrigin: string;
  dev: boolean;
  frames: boolean;
  framedBySelf?: boolean;
}): { key: string; value: string }[] {
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'X-Frame-Options',
      value: options.framedBySelf ? 'SAMEORIGIN' : 'DENY',
    },
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(options) },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
  ];
}
