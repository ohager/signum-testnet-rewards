import { readSnapshot } from "@/lib/queries";
import { toWire } from "@/lib/readModel";
import type { SnapshotWire } from "@/lib/readModel";

/**
 * The snapshot the browser polls.
 *
 * `force-static` + `revalidate` is the whole reason polling is affordable. Next
 * caches this response on the CDN, so a hundred viewers refreshing every 30
 * seconds still cost ONE database read per window — the number of viewers stops
 * mattering, only the clock does. Without it, row reads would scale with
 * traffic, which is the failure mode the read-model was built to avoid.
 *
 * Route handlers are dynamic by default since Next 15, so the opt-in has to be
 * explicit. Nothing here reads headers, cookies or the URL, which is what makes
 * it eligible.
 */
export const dynamic = "force-static";

/**
 * Matches PUBLISH_INTERVAL_SECONDS on the service: the publisher writes at most
 * every 30s, so a shorter window would re-read a row that cannot have changed.
 */
export const revalidate = 30;

export type StatusResponse =
  | { kind: "ok"; snapshot: SnapshotWire }
  | { kind: "empty" }
  | { kind: "unconfigured" };

export async function GET(): Promise<Response> {
  const result = await readSnapshot();

  const body: StatusResponse =
    result.kind === "ok" ? { kind: "ok", snapshot: toWire(result.snapshot) } : result;

  return Response.json(body);
}
