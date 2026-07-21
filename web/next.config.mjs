import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // web/app/api/knowledge/* Route Handlers import shared sync logic directly
  // from ../scripts/lib (outside this project root) instead of a duplicated
  // or separately-packaged copy. This makes sure a production build's file
  // tracing follows those imports too.
  experimental: {
    outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
  },
};

export default nextConfig;
