import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/metadata';
import { indexingEnabled, sitemapFor } from '@/lib/seo';

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapFor({
    indexing: indexingEnabled(process.env),
    origin: siteOrigin.origin,
  });
}
