import { readSnapshot } from "@/lib/queries";
import { toWire } from "@/lib/readModel";
import { Dashboard } from "@/components/Dashboard";
import type { StatusResponse } from "@/app/api/status/route";

/**
 * Seconds between rebuilds of the server-rendered shell.
 *
 * The live numbers come from SWR polling /api/status, so this only governs how
 * fresh the FIRST paint is for a visitor arriving cold. It stays at 60 rather
 * than dropping to the API's 30 because a page-level revalidation re-renders
 * everything, while the API route re-reads one cached JSON body.
 */
export const revalidate = 60;

const STALENESS_SECONDS = Number(
  process.env.NEXT_PUBLIC_STALENESS_SECONDS ?? 300,
);

/**
 * The page is a server component that renders real data, then hands it to the
 * client as SWR's fallback.
 *
 * Doing the first read here rather than letting the browser fetch it means the
 * page has its numbers in the HTML: no loading spinner, no layout shift, and
 * the content is present for anything that does not run JavaScript.
 */
export default async function Page() {
  const result = await readSnapshot();
  const initial: StatusResponse =
    result.kind === "ok"
      ? { kind: "ok", snapshot: toWire(result.snapshot) }
      : result;

  return (
    <Dashboard
      initial={initial}
      serverNow={Math.floor(Date.now() / 1000)}
      stalenessSeconds={STALENESS_SECONDS}
    />
  );
}
