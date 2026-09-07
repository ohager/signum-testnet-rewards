import { cachedSnapshot } from "@/lib/queries";
import { toWire } from "@/lib/readModel";
import { Dashboard } from "@/components/Dashboard";
import type { StatusResponse } from "@/app/api/status/route";

/**
 * Seconds between rebuilds of the server-rendered shell.
 *
 * ISR is kept for the property it is good at: the request that finds the window
 * lapsed generates the page, and every visitor arriving inside that window is
 * served that same result. One database read fans out to all of them.
 *
 * What it does NOT give is a bound on age. `revalidate` is
 * stale-while-revalidate, so past the window Next serves the previous HTML and
 * rebuilds behind the request — on a quiet page that HTML can be hours old.
 * That is fine for the numbers, which the client corrects on its first poll,
 * but it must never drive the "snapshot stale" badge: see `staleAtRender`.
 */
export const revalidate = 60;

/**
 * How old the published snapshot may be before the page says so.
 *
 * Four missed heartbeats. The service rewrites its status row at least every
 * 60s even when nothing changed, so this measures the publisher's liveness, not
 * the chain's — a testnet that forges nothing for an hour still heartbeats, and
 * this badge would be wrong to fire on it.
 *
 * One heartbeat above the service's own 180s threshold on purpose: the operator
 * is alerted before the public is told.
 */
const STALENESS_SECONDS = Number(
  process.env.NEXT_PUBLIC_STALENESS_SECONDS ?? 240,
);

/**
 * The mainnet account the service pays from, as a numeric account id.
 *
 * Configured here rather than read from the snapshot because the service
 * derives it from a seed it must never publish anything about, and because a
 * deployment that has not enabled payouts still has a treasury worth pointing
 * at. Absent means the line is simply not shown — a wrong account id would be
 * worse than none, since the whole point of it is that a visitor can verify the
 * payments against it.
 */
const PAYOUT_ACCOUNT_ID = process.env.NEXT_PUBLIC_PAYOUT_ACCOUNT_ID?.trim() || null;

/**
 * The page is a server component that renders real data, then hands it to the
 * client as SWR's fallback.
 *
 * Doing the first read here rather than letting the browser fetch it means the
 * page has its numbers in the HTML: no loading spinner, no layout shift, and
 * the content is present for anything that does not run JavaScript. Because the
 * read is bounded rather than cached indefinitely, those numbers are current on
 * arrival — the poll that follows keeps them so, it no longer has to fix them.
 */
export default async function Page() {
  const result = await cachedSnapshot();
  const initial: StatusResponse =
    result.kind === "ok"
      ? { kind: "ok", snapshot: toWire(result.snapshot) }
      : result;

  const serverNow = Math.floor(Date.now() / 1000);

  /**
   * Whether the snapshot was late AT THE MOMENT THIS HTML WAS BUILT.
   *
   * This is the only staleness claim the server can honestly make. Comparing
   * the snapshot against the visitor's clock instead would measure how long
   * this HTML sat in the ISR cache — our own lateness, not the service's — and
   * that is precisely the false accusation the badge used to make on every cold
   * load.
   *
   * It is computed here rather than skipped because a visitor without
   * JavaScript never gets a poll to correct it, and they deserve to be told
   * when the service that produced these numbers had actually stopped.
   */
  const staleAtRender =
    result.kind === "ok" && serverNow - result.snapshot.status.updatedAt > STALENESS_SECONDS;

  return (
    <Dashboard
      initial={initial}
      serverNow={serverNow}
      staleAtRender={staleAtRender}
      stalenessSeconds={STALENESS_SECONDS}
      payoutAccountId={PAYOUT_ACCOUNT_ID}
    />
  );
}
