import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';

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
      <html lang="en">
        <body className="min-h-screen bg-neutral-950 text-neutral-50 antialiased">
          {children}
          <Analytics />
          <SpeedInsights />
        </body>
      </html>
    </ClerkProvider>
  );
}
