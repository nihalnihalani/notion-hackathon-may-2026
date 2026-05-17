/**
 * Canonical origin resolver for SEO surfaces (robots.txt, sitemap.xml,
 * OpenGraph metadata, social-preview routes).
 *
 * The web app reads its public origin from `NEXT_PUBLIC_APP_URL`. On Vercel
 * preview deployments the env is typically the per-deploy URL, on prod it's
 * the apex domain. We fall back to the Vercel-provided `VERCEL_URL`
 * (autoset on every deployment) and finally to a documented placeholder so
 * the build never crashes in environments where the env hasn't been wired
 * yet (e.g. contributor forks running `next build` locally).
 *
 * Trailing slashes are stripped so callers can safely build
 * `${base}/sitemap.xml`.
 */

const FALLBACK_ORIGIN = 'https://forge.example.com';

export function resolveAppUrl(): string {
  const fromEnv = process.env['NEXT_PUBLIC_APP_URL'];
  if (fromEnv && fromEnv.length > 0) {
    return stripTrailingSlash(fromEnv);
  }
  const vercel = process.env['VERCEL_URL'];
  if (vercel && vercel.length > 0) {
    return stripTrailingSlash(
      vercel.startsWith('http') ? vercel : `https://${vercel}`,
    );
  }
  return FALLBACK_ORIGIN;
}

export function appUrlBase(): URL {
  return new URL(resolveAppUrl());
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
