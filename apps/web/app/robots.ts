import type { MetadataRoute } from 'next';

import { resolveAppUrl } from '@/lib/site-url';

/**
 * App-Router robots.txt source.
 *
 * Allow indexing of the public marketing surface (currently just `/`) and
 * disallow everything that's auth-walled or non-crawlable in principle:
 *
 *   - /api/*          → JSON endpoints; nothing to crawl, every request
 *                       must pass Clerk or one of the bespoke auth schemes
 *                       documented in proxy.ts. Disallowing them keeps
 *                       Google from wasting crawl budget on 401s.
 *   - /dashboard*     → the entire authed app. Clerk already redirects,
 *                       but stating the disallow makes the intent obvious
 *                       in audit tools and prevents the redirect chain
 *                       from being indexed under noindex-via-redirect.
 *   - /agents, /generations, /evals, /settings, /onboarding → same as above.
 *
 * The sitemap URL is announced here so crawlers can discover it without
 * relying on a separate Search Console submission.
 */
export default function robots(): MetadataRoute.Robots {
  const base = resolveAppUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/dashboard',
          '/dashboard/',
          '/agents',
          '/agents/',
          '/generations',
          '/generations/',
          '/evals',
          '/evals/',
          '/settings',
          '/settings/',
          '/onboarding',
          '/onboarding/',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
