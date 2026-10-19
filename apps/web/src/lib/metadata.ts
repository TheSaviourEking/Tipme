import type { Metadata } from 'next';
const origin = new URL(process.env.SITE_URL ?? 'http://localhost:3000');
if (
  !['http:', 'https:'].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  origin.pathname !== '/'
) {
  throw new Error(
    'SITE_URL must be an HTTP(S) origin without credentials, path, query or fragment.',
  );
}
export const siteOrigin = origin;
export const shareCard = {
  alt: 'TipMe. A little thanks goes a long way. Non-transactional development preview.',
  width: 1200,
  height: 630,
} as const;
export function previewMetadata(
  title: string,
  description: string,
  path: string,
): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: { index: false, follow: false },
    // Explicit because a page-level `openGraph` replaces the parent's file-based image.
    openGraph: {
      title,
      description,
      url: path,
      siteName: 'TipMe — development preview',
      type: 'website',
      images: [{ url: '/opengraph-image', type: 'image/png', ...shareCard }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [{ url: '/opengraph-image', alt: shareCard.alt }],
    },
  };
}
