import { turso } from "./turso";
import { decodeMiner, decodePayout, decodeStatus } from "./readModel";
import type { Row, Snapshot } from "./readModel";

/**
 * Every read the public site performs, with its row cost stated.
 *
 * Row reads are the metered resource on Turso's free tier (5M/month), and this
 * page is the only thing reading the published database, so its cost is entirely
 * determined here. One full render is:
 *
 *   status    1 row   (single-row table, indexed by primary key)
 *   miners   25 rows  (LIMIT over ix_miners_pending)
 *   payouts  10 rows  (LIMIT over ix_payouts_confirmed)
 *   ────────────────
 *            36 rows
 *
 * Two windows decide how often that happens, and neither of them is the number
 * of viewers: the page regenerates at most once per 60s (`revalidate`) and the
 * API route is fetched from origin at most once per 60s (its `s-maxage`). Each
 * generated result is then shared by everyone arriving inside its window. That
 * is 2880 reads/day → ~3.1M rows/month at a ceiling that only a continuously
 * busy site reaches, against a 5M tier. `cachedSnapshot` sits underneath both
 * and collapses them further when they land on the same instance together.
 *
 * Raising the limits or shortening either window scales this linearly — do the
 * arithmetic before touching any of the three.
 *
 * The counts NEVER come from `COUNT(*)`: a count scans the rows it counts, so
 * it would cost the whole table to render one number. `status.miner_count` is
 * published precisely so the headline is one row read.
 */

export const MINER_LIMIT = 25;
export const PAYOUT_LIMIT = 10;

/**
 * Three outcomes, kept distinct on purpose.
 *
 * "unconfigured" and "empty" both render a page with no numbers on it, but they
 * mean completely different things — nobody set TURSO_DATABASE_URL versus the
 * service has not published yet — and only one of them is anybody's job to fix.
 * A read that fails for any other reason is NOT represented here: it throws, and
 * `app/error.tsx` says so, because silently showing zeroes where the answer is
 * "we could not ask" would misreport money.
 */
export type SnapshotResult =
  | { kind: "ok"; snapshot: Snapshot }
  | { kind: "empty" }
  | { kind: "unconfigured" };

/**
 * Reads the whole page in ONE round trip.
 *
 * `batch` in read mode sends all three statements together, so the page pays a
 * single network latency instead of three sequential ones — which matters more
 * than it looks, because this runs on every ISR revalidation.
 */
export async function readSnapshot(): Promise<SnapshotResult> {
  const client = turso();
  if (!client) return { kind: "unconfigured" };

  const [statusResult, minersResult, payoutsResult] = await client.batch(
    [
      { sql: "SELECT * FROM status WHERE id = 1", args: [] },
      {
        sql: `SELECT * FROM miners
               ORDER BY pending_planck DESC, paid_planck DESC
               LIMIT ?`,
        args: [MINER_LIMIT],
      },
      {
        sql: `SELECT * FROM payouts
               WHERE confirmed_at IS NOT NULL
               ORDER BY confirmed_at DESC
               LIMIT ?`,
        args: [PAYOUT_LIMIT],
      },
    ],
    "read",
  );

  const statusRow = statusResult?.rows[0];
  // No status row means the service has never published. That is a real state
  // on a fresh deployment, not an error, and the page renders a waiting notice.
  if (!statusRow) return { kind: "empty" };

  return {
    kind: "ok",
    snapshot: {
      status: decodeStatus(statusRow as unknown as Row),
      miners: (minersResult?.rows ?? []).map((r) => decodeMiner(r as unknown as Row)),
      payouts: (payoutsResult?.rows ?? []).map((r) => decodePayout(r as unknown as Row)),
    },
  };
}

/**
 * How long ONE database read is reused for, across every request the process
 * serves. Matches the publisher's 30s tick: a shorter window would re-read rows
 * that cannot have changed.
 */
const SNAPSHOT_TTL_MS = 30_000;

let memo: { readAt: number; result: Promise<SnapshotResult> } | null = null;

/**
 * `readSnapshot`, but at most once per {@link SNAPSHOT_TTL_MS} per instance.
 *
 * This is what lets both the page and the API route render WITHOUT being served
 * from a cache that may be arbitrarily old. Next's `revalidate` is
 * stale-while-revalidate: past the window it hands the visitor the previous
 * body and regenerates behind them, so on a low-traffic site the first paint
 * could be hours old — which is exactly what the "snapshot stale" badge was
 * reporting, correctly, until the first poll replaced it.
 *
 * Here the age is BOUNDED instead: a read older than the window is awaited, not
 * skipped over. The row cost stays flat in traffic because it is the clock that
 * decides when to read, not the number of viewers — the property the read-model
 * exists to protect.
 *
 * The promise is memoised, not the value, so concurrent requests arriving on a
 * cold cache share one round trip rather than starting one each. A rejected
 * read evicts itself: a failure is a moment, and caching it for 30s would turn
 * one bad round trip into 30 seconds of error page.
 */
export function cachedSnapshot(): Promise<SnapshotResult> {
  const now = Date.now();
  if (memo && now - memo.readAt < SNAPSHOT_TTL_MS) return memo.result;

  const result = readSnapshot();
  const entry = { readAt: now, result };
  memo = entry;
  result.catch(() => {
    if (memo === entry) memo = null;
  });
  return result;
}
