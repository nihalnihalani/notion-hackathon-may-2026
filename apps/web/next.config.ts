import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `typedRoutes` graduated from experimental → stable in Next 16. The
  // experimental flag is now a no-op and emits a deprecation warning at build
  // time, so keep it at top-level only.
  typedRoutes: true,
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
