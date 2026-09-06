import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Pinned because the service repo above this folder has its own bun.lock, and
  // Turbopack would otherwise infer the workspace root from whichever lockfile
  // it finds first. This app is its own deployment root; Vercel's Root
  // Directory setting points here.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },

  // The site is a read-only view of a database published elsewhere: no user
  // input, no auth, no writes.
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
