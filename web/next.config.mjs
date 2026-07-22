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
    // Route Handlers that cross-import scripts/lib/*.mjs (outside this
    // project) seem to crash Next's dev-mode jest-worker pool ("2 child
    // process exceptions" + EPIPE) under multi-worker parallelism on this
    // machine. Single-worker mode avoids it; revisit if a Next.js upgrade
    // fixes the underlying worker-pool issue.
    cpus: 1,
    // The client Router Cache otherwise keeps reusing a dynamic page's RSC
    // payload across normal in-app navigations (not just prefetch), so
    // Agent Setup could show data that was already deleted/changed server
    // side until a hard reload. This page is already `dynamic =
    // "force-dynamic"` and sends `Cache-Control: no-store`; disabling the
    // client-side cache duration too makes every navigation here actually
    // re-fetch.
    staleTimes: {
      dynamic: 0,
    },
  },
};

export default nextConfig;
