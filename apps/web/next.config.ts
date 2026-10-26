import type { NextConfig } from 'next';
import { parseProductionLaunchAt } from './src/lib/production-launch';

// Validate this at build/start time so a malformed production launch cannot silently expose or
// indefinitely hide the site. The request-time gate reads the same server-only value.
parseProductionLaunchAt(process.env.PRODUCTION_LAUNCH_AT);

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN || 'http://localhost:4000';
const apiUrl = new URL(apiOrigin);
if (
  !['http:', 'https:'].includes(apiUrl.protocol) ||
  apiUrl.username ||
  apiUrl.password ||
  apiUrl.pathname !== '/' ||
  apiUrl.search ||
  apiUrl.hash
) {
  throw new Error(
    'NEXT_PUBLIC_API_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment.',
  );
}

// Inline scripts/styles are required by statically rendered Next.js pages (nonces would force
// dynamic rendering; deferred, threat model X1); every other resource class is restricted, and
// the browser may reach only this site and the configured API origin.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // React's development build needs eval() for its debugging tools; production never does.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      // Uploaded profile photos are served by the API (/v1/avatars/...).
      `img-src 'self' data: blob: ${apiUrl.origin}`,
      "font-src 'self' data:",
      `connect-src 'self' ${apiUrl.origin}`,
      "media-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Public profiles live at /@handle (PRD). A folder starting with "@" is a parallel-route slot
  // in the App Router, so /@handle is rewritten to the internal people/[handle] route. The legacy
  // /people/handle redirect lives in Proxy so the production launch gate runs before it.
  async rewrites() {
    return [{ source: '/@:handle', destination: '/people/:handle' }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
