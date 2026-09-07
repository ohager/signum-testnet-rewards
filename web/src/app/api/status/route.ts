import { cachedSnapshot } from "@/lib/queries";
import { toWire } from "@/lib/readModel";
import type { SnapshotWire } from "@/lib/readModel";

/**
 * The snapshot the browser polls.
 *
 * Deliberately NOT `force-static`. Next's `revalidate` is
 * stale-while-revalidate: once the window lapses it serves the previous body
 * and regenerates behind the request, so the first poll after a quiet spell
 * returned a snapshot of unbounded age and only the SECOND one, 30s later, was
 * current. That is what put a "snapshot stale" badge on every cold visit.
 *
 * Rendering per request instead does not mean reading per request:
 * `cachedSnapshot` bounds the database to one read per 30s per instance, and
 * the `Cache-Control` below bounds how often a request reaches an instance at
 * all. Both are clock-driven, so a hundred viewers still cost what one does —
 * the property `force-static` was there for — but neither can serve something
 * older than its window.
 */
export const dynamic = "force-dynamic";

export type StatusResponse =
  | { kind: "ok"; snapshot: SnapshotWire }
  | { kind: "empty" }
  | { kind: "unconfigured" };

/**
 * The same fan-out ISR gives the page — one origin call per window, shared by
 * everyone arriving inside it — but with NO `stale-while-revalidate`, so a
 * lapsed entry is refetched rather than served old.
 *
 * That bound is what makes this route usable as the page's freshness oracle:
 * the badge only accuses the service once a body from HERE has been measured,
 * so this body's age has to be something we can state. Worst case is one CDN
 * window plus one memo window, ~90s, comfortably inside the 240s threshold.
 */
const CACHE_CONTROL = "public, s-maxage=60";

export async function GET(): Promise<Response> {
  const result = await cachedSnapshot();

  const body: StatusResponse =
    result.kind === "ok" ? { kind: "ok", snapshot: toWire(result.snapshot) } : result;

  return Response.json(body, { headers: { "Cache-Control": CACHE_CONTROL } });
}
