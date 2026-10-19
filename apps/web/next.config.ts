import type { NextConfig } from 'next';

// Baseline headers that are compatible with static prerendering. A script-src/style-src CSP
// needs per-request nonces (forcing dynamic rendering) and is deferred to a security ADR.
// HSTS belongs at the HTTPS edge once a production domain is approved.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Content-Security-Policy',
    value:
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Public profiles live at /@handle (PRD). A folder starting with "@" is a parallel-route slot
  // in the App Router, so /@handle is rewritten to the internal people/[handle] route, and
  // the old /people/handle URLs redirect permanently. Redirects only match incoming URLs,
  // so the two cannot loop.
  async redirects() {
    return [
      { source: '/people/:handle', destination: '/@:handle', permanent: true },
    ];
  },
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
