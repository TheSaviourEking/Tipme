import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/metadata';
import { indexingEnabled, robotsFor } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return robotsFor({
    indexing: indexingEnabled(process.env),
    origin: siteOrigin.origin,
  });
}
