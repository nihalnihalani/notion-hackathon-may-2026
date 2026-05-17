import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `typedRoutes` graduated from experimental → stable in Next 16. The
  // experimental flag is now a no-op and emits a deprecation warning at build
  // time, so keep it at top-level only.
  typedRoutes: true,
  images: {
    // MiniMax serves agent avatars from these hosts. Vercel Blob hosts
    // generated source artifacts (also fetched via next/image when we surface
    // a thumbnail). Wildcard hostname = locked-down to remote pattern, not
    // open redirect (Next still validates path).
    remotePatterns: [
      { protocol: 'https', hostname: '*.minimax.io' },
      { protocol: 'https', hostname: '*.minimaxi.chat' },
      { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
    ],
  },
  transpilePackages: [
    '@forge/agents',
    '@forge/ntn-wrapper',
    '@forge/notion-client',
    '@forge/connectors',
    '@forge/db',
    '@forge/safety',
    '@forge/workflows',
    '@forge/mcp-server',
    '@forge/installer',
    '@forge/eval-harness',
  ],
};

export default nextConfig;
