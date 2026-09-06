import type { Ledger } from "./db.ts";
import type { ForkComparison } from "../health/forkCheck.ts";

/**
 * Every fork check is recorded, including the boring agreements.
 *
 * A fork is exactly the kind of incident that gets investigated after the fact,
 * and "which nodes said what, at which height, when" is unrecoverable once the
 * losing chain is gone. The rows are small and pruned with the health samples.
 */
export function recordForkObservation(
  db: Ledger,
  comparison: ForkComparison,
  checkedAt: number,
): void {
  db.query(
    `INSERT INTO fork_observations
       (checked_at, height, verdict, local_block_id, local_gen_sig, detail)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(
    checkedAt,
    comparison.height ?? null,
    comparison.verdict,
    comparison.local?.blockId ?? null,
    comparison.local?.generationSignature ?? null,
    JSON.stringify({
      agreeing: comparison.agreeingHosts,
      disagreeing: comparison.disagreeingHosts,
      unreachable: comparison.abstainingHosts,
      message: comparison.message,
    }),
  );
}

export function pruneForkObservations(db: Ledger, olderThanEpochSeconds: number): number {
  return db.query("DELETE FROM fork_observations WHERE checked_at < ?1").run(olderThanEpochSeconds)
    .changes;
}

export function recentForkObservations(db: Ledger, limit: number) {
  return db
    .query(
      `SELECT checked_at, height, verdict, local_block_id, local_gen_sig, detail
         FROM fork_observations ORDER BY checked_at DESC LIMIT ?1`,
    )
    .all(limit);
}
