import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    typedRoutes: true,
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
