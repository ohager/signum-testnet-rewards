import { existsSync, unlinkSync } from "node:fs";
import type { Ledger } from "../ledger/db.ts";
import type { LedgerPaths } from "../config/load.ts";
import { PUBLISH_SCHEMA_SQL, parseSchemaColumns } from "../publish/tursoSchema.ts";

/** A batch that makes a reset unsafe, with enough detail to look it up on chain. */
export interface BlockingBatch {
  id: number;
  status: string;
  txId: string | null;
  totalPlanck: number | null;
  createdAt: number;
}

export type ResetAssessment =
  | { safe: true }
  | { safe: false; reason: string; batches: BlockingBatch[] };

/**
 * Whether local state can be thrown away without risking a double payment.
 *
 * The danger is not the reset but what follows it: the walker cache and the
 * ledger are separate files, and wiping both makes the walker restart at
 * START_HEIGHT and re-accrue every block with `batch_id NULL`. Rewards already
 * paid become payable again, and nothing consults mainnet to notice. The
 * `INSERT OR IGNORE` on block_id defends against a REPLAY, not against a wipe.
 *
 * So every batch must be provably dead. `failed` is the only such status: a
 * batch is released only once its deadline has passed, and expiry is
 * consensus-enforced, so its transaction can never be included afterwards.
 * Every other status means money left, is leaving, or has an unknown fate.
 */
export function assessReset(db: Ledger): ResetAssessment {
  const rows = db
    .query(
      `SELECT id, status, tx_id AS txId, total_planck AS totalPlanck, created_at AS createdAt
         FROM batches
        WHERE status <> 'failed'
        ORDER BY id`,
    )
    .all() as BlockingBatch[];

  if (rows.length === 0) return { safe: true };

  const confirmed = rows.filter((b) => b.status === "confirmed").length;
  const unresolved = rows.length - confirmed;
  return {
    safe: false,
    reason:
      `${rows.length} batch(es) are not provably dead: ${confirmed} confirmed, ` +
      `${unresolved} still live or unresolved. Resetting would erase the record that ` +
      `they were paid, and the walker would re-accrue those rewards as unpaid.`,
    batches: rows,
  };
}

/** The client surface the wipe needs, so tests need no network. */
export interface RemoteWiper {
  batch: (statements: string[]) => Promise<unknown>;
}

/**
 * Empties the published read-model.
 *
 * Table names come from the publish DDL rather than a hand-written list, so a
 * table added to the read-model cannot be silently left behind holding stale
 * rows that nothing would ever overwrite: the publisher only ever upserts.
 */
export async function wipeRemote(client: RemoteWiper): Promise<string[]> {
  const tables = [...parseSchemaColumns(PUBLISH_SCHEMA_SQL).keys()];
  await client.batch(tables.map((t) => `DELETE FROM ${t}`));
  return tables;
}

/**
 * Removes the ledger and the walker cache, and the SQLite sidecars with them.
 *
 * Both go or neither: leaving the walker cache behind would make the next start
 * resume at the current height against an empty ledger, silently skipping every
 * block before it instead of re-indexing them.
 */
export function removeLocalFiles(paths: LedgerPaths): string[] {
  const targets = [
    paths.databasePath,
    `${paths.databasePath}-wal`,
    `${paths.databasePath}-shm`,
    paths.walkerCachePath,
  ];
  const removed: string[] = [];
  for (const path of targets) {
    if (!existsSync(path)) continue;
    unlinkSync(path);
    removed.push(path);
  }
  return removed;
}
