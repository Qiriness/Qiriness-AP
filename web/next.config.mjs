import { fileURLToPath } from "node:url";

import { loadEnv } from "../scripts/lib/sync-config.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Single source of truth for secrets: the repo-root .env.local — the same file
// the Node sync scripts read. Next.js only auto-loads env files from this web/
// directory, so we hydrate process.env from the parent file here, before any
// Route Handler runs loadConfig(process.env).
hydrateProcessEnv();

function hydrateProcessEnv() {
  // loadEnv() seeds from process.env and never overwrites a key it already
  // has, so a real environment variable — or a lingering web/.env.local, which
  // Next loads before this config — still wins over the repo-root file.
  for (const [key, value] of Object.entries(loadEnv(repoRoot))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // web/app/api/knowledge/* Route Handlers import shared sync logic directly
    // from ../scripts/lib (outside this project root) instead of a duplicated
    // or separately-packaged copy. This makes sure a production build's file
    // tracing follows those imports too.
    outputFileTracingRoot: repoRoot,
    // Route Handlers that cross-import scripts/lib/*.mjs (outside this
    // project) seem to crash Next's dev-mode jest-worker pool ("2 child
    // process exceptions" + EPIPE) under multi-worker parallelism on this
    // machine. Single-worker mode avoids it; revisit if a Next.js upgrade
    // fixes the underlying worker-pool issue.
    cpus: 1,
    // The client Router Cache otherwise keeps reusing a dynamic page's RSC
    // payload across normal in-app navigations (not just prefetch), so
    // Agent Setup could show data that was already deleted/changed server
    // side until a hard reload. That page is already `dynamic =
    // "force-dynamic"` and sends `Cache-Control: no-store`; disabling the
    // client-side cache duration too makes every navigation here actually
    // re-fetch.
    staleTimes: {
      dynamic: 0,
    },
  },
};

export default nextConfig;
