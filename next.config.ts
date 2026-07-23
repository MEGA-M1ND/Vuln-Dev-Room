import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: {
    // Lint is run explicitly in CI via `npm run lint`; do not fail production
    // builds on lint so `next build` stays fast and deterministic.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
