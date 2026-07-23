import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

// Single source of truth for secrets: the repo-root .env.local — the same file
// the Node sync scripts read via scripts/lib/sync-config.mjs. Next.js only
// auto-loads env files from this web/ directory, so we load the parent file
// here, before any Route Handler runs loadConfig(process.env). Only keys not
// already set are filled, so a real environment variable (or a lingering
// web/.env.local, if one still exists) still wins. Mirrors sync-config.mjs's
// tiny parser rather than adding a dotenv dependency.
loadRootEnvLocal();

function loadRootEnvLocal() {
  const path = fileURLToPath(new URL("../.env.local", import.meta.url));
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }
    const value = rawValue.trim();
    const unquoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;
    process.env[key] = unquoted;
  }
}

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
