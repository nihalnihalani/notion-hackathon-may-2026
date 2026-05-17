import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Forge — Notion Custom Agent Studio',
  description:
    'Describe an agent in plain English. Forge ships a real, deployed Notion Custom Agent in 90 seconds.',
  metadataBase: new URL('https://forge.dev'),
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
