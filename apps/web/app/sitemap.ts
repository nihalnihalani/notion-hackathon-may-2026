import type { MetadataRoute } from 'next';

import { resolveAppUrl } from '@/lib/site-url';

/**
 * App-Router sitemap.xml source.
 *
 * Forge is product-led with a tiny public footprint — the marketing/landing
 * page at `/` is the only crawlable route today. The authed dashboard sits
 * behind Clerk and is intentionally excluded (mirrored in robots.ts).
 *
 * Add new public routes here only — never auto-enumerate `app/` because the
 * (authed) group should stay invisible to crawlers.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = resolveAppUrl();
  const now = new Date();
  return [
    {
      url: `${base}/`,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
