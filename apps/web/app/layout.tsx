import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';

import { PostHogProvider } from '@/components/posthog-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { appUrlBase, resolveAppUrl } from '@/lib/site-url';
import './globals.css';

// Sentry's client SDK is loaded automatically by Next.js from
// `apps/web/instrumentation-client.ts` and server/edge SDKs from
// `apps/web/instrumentation.ts`. No explicit import is needed here — this
// comment exists so future contributors know where to look when they want
// to find the init site.

const SITE_TITLE = 'Forge — Notion Custom Agent Studio';
const SITE_DESCRIPTION =
  'Describe an agent in plain English. Forge ships a real, deployed Notion Custom Agent in 90 seconds.';
const SITE_NAME = 'Forge';

// Canonical origin (NEXT_PUBLIC_APP_URL or fallback). The OG image route is
// auto-discovered by Next.js as `/opengraph-image` — listing it explicitly
// keeps the resolved absolute URL deterministic across all platforms.
const METADATA_BASE = appUrlBase();
const CANONICAL_URL = resolveAppUrl();

export const metadata: Metadata = {
  metadataBase: METADATA_BASE,
  title: {
    default: SITE_TITLE,
    template: '%s · Forge',
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: '/' },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  openGraph: {
    type: 'website',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: CANONICAL_URL,
    siteName: SITE_NAME,
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: SITE_TITLE,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ['/twitter-image'],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      {/*
        `suppressHydrationWarning` is required by next-themes — it injects a
        `class="dark"` before React hydrates, which would otherwise mismatch.
      */}
      <html lang="en" suppressHydrationWarning>
        <body className="min-h-screen bg-background font-sans text-foreground antialiased">
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            {/*
              PostHogProvider uses `useSearchParams` for pageview capture,
              which Next 16 requires to live inside a Suspense boundary so
              partial prerendering can isolate the dynamic read. An empty
              fallback is fine — the provider renders children unchanged.
            */}
            <Suspense fallback={null}>
              <PostHogProvider>{children}</PostHogProvider>
            </Suspense>
            <Toaster position="bottom-right" />
          </ThemeProvider>
          <Analytics />
          <SpeedInsights />
        </body>
      </html>
    </ClerkProvider>
  );
}
