import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';

import { PostHogProvider } from '@/components/posthog-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

// Sentry's client SDK is loaded automatically by Next.js from
// `apps/web/instrumentation-client.ts` and server/edge SDKs from
// `apps/web/instrumentation.ts`. No explicit import is needed here — this
// comment exists so future contributors know where to look when they want
// to find the init site.

// Resolve the canonical origin from env. If NEXT_PUBLIC_APP_URL is missing we
// intentionally leave `metadataBase` undefined so Next.js falls back to relative
// URLs (rather than baking a wrong "forge.dev" origin into every preview
// deployment's OpenGraph tags).
const appUrl = process.env['NEXT_PUBLIC_APP_URL'];

export const metadata: Metadata = {
  title: 'Forge — Notion Custom Agent Studio',
  description:
    'Describe an agent in plain English. Forge ships a real, deployed Notion Custom Agent in 90 seconds.',
  metadataBase: appUrl ? new URL(appUrl) : undefined,
  openGraph: {
    title: 'Forge — Notion Custom Agent Studio',
    description:
      'Describe an agent in plain English. Forge ships a real, deployed Notion Custom Agent in 90 seconds.',
    type: 'website',
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
