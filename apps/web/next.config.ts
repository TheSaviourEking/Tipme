import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';
import { buildVersion } from './src/lib/build-version';
import { parseProductionLaunchAt } from './src/lib/production-launch';
import {
  PUBLIC_PAGE_SOURCE,
  STUDIO_PREVIEW_SOURCE,
  securityHeaders,
} from './src/lib/security-headers';

// Validate this at build/start time so a malformed production launch cannot silently expose or
// indefinitely hide the site. The request-time gate reads the same server-only value.
parseProductionLaunchAt(process.env.PRODUCTION_LAUNCH_AT);

// The build's identity (src/lib/build-version.ts): the deploy passes TIPME_BUILD_VERSION.
const version = buildVersion(process.env, () =>
  execSync('git rev-parse HEAD', {
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString(),
);

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

// The site-wide headers, and the public page's, which may also frame a Page Studio video.
const dev = process.env.NODE_ENV === 'development';
const siteHeaders = securityHeaders({
  apiOrigin: apiUrl.origin,
  dev,
  frames: false,
});
const publicPageHeaders = securityHeaders({
  apiOrigin: apiUrl.origin,
  dev,
  frames: true,
});
// Page Studio's preview: only this site may frame it (the editor's live preview).
const studioPreviewHeaders = securityHeaders({
  apiOrigin: apiUrl.origin,
  dev,
  frames: false,
  framedBySelf: true,
});

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Self-hosted on the server behind the edge Caddy (deploy/web.Dockerfile, 26 Nov 2026): a
  // standalone server with only the files it needs. Traced from the repository root, so the
  // workspace packages come along.
  output: 'standalone',
  outputFileTracingRoot: join(__dirname, '../..'),
  // The edge compresses (zstd, gzip) and leaves streamed pages unbuffered; Next's own gzip would
  // only be passed through it.
  compress: false,
  env: { TIPME_BUILD_VERSION: version },
  // Public profiles live at /@handle (PRD). A folder starting with "@" is a parallel-route slot
  // in the App Router, so /@handle is rewritten to the internal people/[handle] route. The legacy
  // /people/handle redirect lives in Proxy so the production launch gate runs before it.
  async rewrites() {
    return [
      { source: '/@:handle', destination: '/people/:handle' },
      // Campaign Studio: a campaign link opens the same page (people/[handle]/[campaign]).
      {
        source: '/@:handle/:campaign',
        destination: '/people/:handle/:campaign',
      },
    ];
  },
  async headers() {
    // When two entries set one header for a path, the later one wins: the public page's last.
    return [
      { source: '/:path*', headers: siteHeaders },
      { source: PUBLIC_PAGE_SOURCE, headers: publicPageHeaders },
      { source: STUDIO_PREVIEW_SOURCE, headers: studioPreviewHeaders },
    ];
  },
  // How it works is a section of Home now (the owner, 3 Nov 2026); old links land on it.
  async redirects() {
    return [
      {
        source: '/how-it-works',
        destination: '/#how-it-works',
        permanent: true,
      },
    ];
  },
  // The portraits are 960px wide, so a candidate above that only re-encodes the same pixels under
  // another URL (and the resizer never enlarges). Cap the ladder at the real width.
  // Cover artwork asks for quality 85 so the optimiser doesn't add a second visible lossy pass.
  // The resized copies are kept on a 128 MB tmpfs in the self-hosted container
  // (deploy/compose.*.yml), so the cache stays well inside it.
  images: {
    deviceSizes: [640, 750, 828, 960],
    qualities: [75, 85],
    maximumDiskCacheSize: 64 * 1024 * 1024,
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

// Error reports reach Sentry through this site (/sentry-tunnel), so the Content Security Policy
// above stays limited to this site and the API. Source maps are uploaded, then removed from the
// deployment, only when SENTRY_AUTH_TOKEN is set (Vercel); local and CI builds upload nothing.
export default withSentryConfig(nextConfig, {
  org: 'tipme-fs',
  project: 'tipme-web',
  authToken: process.env.SENTRY_AUTH_TOKEN,
  tunnelRoute: '/sentry-tunnel',
  silent: !process.env.SENTRY_AUTH_TOKEN,
  telemetry: false,
  widenClientFileUpload: true,
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
});
