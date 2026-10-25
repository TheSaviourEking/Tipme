// robots.txt and sitemap.xml (PR-011). Pure so they can be tested without Next.
//
// Indexing stays off until launch: every copy today is a non-transactional preview, and preview
// copies behind the password must never be crawled. Private areas are disallowed even once it is on.

export const PRIVATE_PATHS = [
  '/dashboard',
  '/ops',
  '/dev',
  '/mock-checkout',
  '/tip/',
  '/preview-login',
  '/preview-states',
  '/design-system',
  '/api/',
  '/sign-in',
  '/sign-up',
  '/recover',
  '/verify-email',
];

const MARKETING_PATHS = ['/', '/how-it-works', '/for-creators'];

export interface SeoInput {
  indexing: boolean;
  origin: string;
}

export function robotsFor({ indexing, origin }: SeoInput) {
  if (!indexing) return { rules: [{ userAgent: '*', disallow: '/' }] };
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: PRIVATE_PATHS }],
    sitemap: `${origin}/sitemap.xml`,
  };
}

export function sitemapFor({ indexing, origin }: SeoInput) {
  if (!indexing) return [];
  return MARKETING_PATHS.map((path) => ({
    url: path === '/' ? `${origin}/` : `${origin}${path}`,
    changeFrequency: 'monthly' as const,
  }));
}

/** On only when explicitly enabled AND this copy is not behind the preview password. */
export function indexingEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return env['SITE_INDEXING'] === 'on' && !env['PREVIEW_PASSWORD'];
}

export function marketingRobots(env: Record<string, string | undefined>): {
  index: boolean;
  follow: boolean;
} {
  const enabled = indexingEnabled(env);
  return { index: enabled, follow: enabled };
}
