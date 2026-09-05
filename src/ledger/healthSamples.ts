import type { Ledger } from "./db.ts";

export interface HealthSampleInput {
  sampledAt: number;
  localHeight: number | null;
  globalHeight: number | null;
  inSync: boolean;
  peerCount: number | null;
  secondsSinceLastBlock: number | null;
  status: string;
}

export function recordHealthSample(db: Ledger, sample: HealthSampleInput): void {
  db.query(
    `INSERT INTO health_samples
       (sampled_at, local_height, global_height, in_sync, peer_count,
        seconds_since_last_block, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(
    sample.sampledAt,
    sample.localHeight,
    sample.globalHeight,
    sample.inSync ? 1 : 0,
    sample.peerCount,
    sample.secondsSinceLastBlock,
    sample.status,
  );
}

/** Keeps the table bounded; the Pi's disk is not infinite and the page only charts recent history. */
export function pruneHealthSamples(db: Ledger, olderThanEpochSeconds: number): number {
  return db.query("DELETE FROM health_samples WHERE sampled_at < ?1").run(olderThanEpochSeconds)
    .changes;
}

export function recentHealthSamples(db: Ledger, limit: number) {
  return db
    .query(
      `SELECT sampled_at, local_height, global_height, in_sync, peer_count,
              seconds_since_last_block, status
         FROM health_samples ORDER BY sampled_at DESC LIMIT ?1`,
    )
    .all(limit);
}
