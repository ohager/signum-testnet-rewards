import { createClient } from "@libsql/client/web";
import type { Client } from "@libsql/client/web";

/**
 * The read-only Turso connection, or undefined when none is configured.
 *
 * `@libsql/client/web` rather than `@libsql/client`: the default entrypoint
 * resolves a native binding for embedded replicas, which serverless and edge
 * runtimes cannot load. The /web build speaks plain HTTP and is all a reader
 * needs.
 *
 * The token this uses MUST be read-only (`turso db tokens create <db>
 * --read-only`). Nothing here writes, so a write-capable token in Vercel's
 * environment would be pure downside risk.
 *
 * Returning undefined rather than throwing on missing configuration is what
 * lets `next build` succeed in a fresh clone: the page is statically prerendered
 * at build time, so an unconfigured environment would otherwise fail the build
 * rather than the request. A database that is configured but unreachable still
 * throws — see `readSnapshot`.
 */
let client: Client | undefined;

export function turso(): Client | undefined {
  if (client) return client;

  const url = process.env.TURSO_DATABASE_URL;
  if (!url) return undefined;

  client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return client;
}
