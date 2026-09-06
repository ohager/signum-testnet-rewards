import type { Ledger } from "./db.ts";
import { pruneHealthSamples } from "./healthSamples.ts";
import { pruneForkObservations } from "./forkObservations.ts";

export interface RetentionResult {
  healthSamples: number;
  forkObservations: number;
  alerts: number;
  mainnetAccounts: number;
}

/**
 * Drops observability rows past the retention window.
 *
 * `block_rewards` and `batches` are deliberately NOT pruned, and the reason is
 * worth stating because it looks like an omission:
 *
 *  - a block_rewards row is the first guard against paying for the same block
 *    twice. Deleting it would mean a replayed block — a lost walker cache, a
 *    start height set low by hand — accrues a second time;
 *  - the projection derives lifetime `blocksMined` and `totalDistributed` from
 *    those rows, so pruning would make the public page's totals shrink;
 *  - both tables are small. Blocks arrive at ~360/day and batches at a handful,
 *    against ~1,440 health samples a day.
 *
 * Local disk is the cheap resource here. The expensive one is Turso, which is
 * bounded separately by the publisher.
 */
export function pruneLedger(db: Ledger, olderThanEpochSeconds: number): RetentionResult {
  const run = db.transaction((): RetentionResult => {
    // Open alerts are never dropped, however old: an unresolved incident is
    // current state, not history.
    const alerts = db
      .query(`DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?1`)
      .run(olderThanEpochSeconds).changes;

    // A TTL cache. A dropped entry is re-fetched on the account's next block.
    const mainnetAccounts = db
      .query(`DELETE FROM mainnet_accounts WHERE last_checked_at < ?1`)
      .run(olderThanEpochSeconds).changes;

    return {
      healthSamples: pruneHealthSamples(db, olderThanEpochSeconds),
      forkObservations: pruneForkObservations(db, olderThanEpochSeconds),
      alerts,
      mainnetAccounts,
    };
  });
  return run();
}
