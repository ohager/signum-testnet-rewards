import { turso } from "./turso";
import { decodeMiner, decodePayout, decodeStatus } from "./readModel";
import type { Miner, Payout, Row, Status } from "./readModel";

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
 * At `revalidate = 60` that is at most 1440 renders/day → ~1.6M rows/month,
 * comfortably inside the tier with room for traffic spikes to be absorbed by
 * the cache rather than by the database. Raising the limits or lowering the
 * revalidate window both scale this linearly — do the arithmetic before either.
 *
 * The counts NEVER come from `COUNT(*)`: a count scans the rows it counts, so
 * it would cost the whole table to render one number. `status.miner_count` is
 * published precisely so the headline is one row read.
 */

export const MINER_LIMIT = 25;
export const PAYOUT_LIMIT = 10;

export interface Snapshot {
  status: Status;
  miners: Miner[];
  payouts: Payout[];
}

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
