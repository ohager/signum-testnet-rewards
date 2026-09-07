import type { Amount } from "@signumjs/util";
import type { Ledger } from "./db.ts";
import type { BlockRewardStatus, ChainDay } from "../domain/types.ts";
import { toPlanckInt, fromPlanckInt } from "../domain/money.ts";

export interface BlockRewardInput {
  blockId: string;
  height: number;
  blockTimestamp: number;
  chainDay: ChainDay;
  generatorId: string;
  generatorPublicKey: string;
  status: BlockRewardStatus;
  amount: Amount;
}

export interface BlockRewardRow extends BlockRewardInput {
  batchId: number | null;
  createdAt: number;
  /** When a reorg invalidated this block. Null for every block still on the chain. */
  orphanedAt: number | null;
}

/**
 * Records the outcome of one observed block.
 *
 * The conflict clause on the block_id primary key is the first of the two
 * idempotency layers: the chain walker's JSON cache and this database are
 * separate files that can disagree after a crash, so the walker may replay
 * blocks. A replay must be a silent no-op rather than a second accrual.
 *
 * The one exception is a block this service previously orphaned. A chain can
 * reorg BACK — the branch we discarded wins after all — and that block's reward
 * is owed again. Restoring it re-runs the current decision rather than reviving
 * the old one, because the caps it has to fit inside have moved on since. The
 * guard keeps every other replay a no-op: without it, this would be an upsert
 * that quietly rewrites settled history.
 *
 * `batch_id` is deliberately untouched: if the row was already paid, it stays
 * paid, and the audit raises that separately.
 *
 * @returns true if a row was inserted or restored, false if this block was already recorded.
 */
export function recordBlockReward(db: Ledger, input: BlockRewardInput): boolean {
  const result = db
    .query(
      `INSERT INTO block_rewards
         (block_id, height, block_timestamp, chain_day, generator_id,
          generator_public_key, status, amount_planck, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(block_id) DO UPDATE SET
         status        = excluded.status,
         amount_planck = excluded.amount_planck,
         orphaned_at   = NULL
       WHERE block_rewards.orphaned_at IS NOT NULL`,
    )
    .run(
      input.blockId,
      input.height,
      input.blockTimestamp,
      input.chainDay,
      input.generatorId,
      input.generatorPublicKey,
      input.status,
      toPlanckInt(input.amount),
      Math.floor(Date.now() / 1000),
    );
  return result.changes === 1;
}

function toBlockRewardRow(row: Record<string, unknown>): BlockRewardRow {
  return {
    blockId: row.block_id as string,
    height: row.height as number,
    blockTimestamp: row.block_timestamp as number,
    chainDay: row.chain_day as string,
    generatorId: row.generator_id as string,
    generatorPublicKey: row.generator_public_key as string,
    status: row.status as BlockRewardStatus,
    amount: fromPlanckInt(row.amount_planck as number),
    batchId: (row.batch_id as number | null) ?? null,
    createdAt: row.created_at as number,
    orphanedAt: (row.orphaned_at as number | null) ?? null,
  };
}

export function getBlockReward(db: Ledger, blockId: string): BlockRewardRow | undefined {
  const row = db
    .query(
      `SELECT block_id, height, block_timestamp, chain_day, generator_id,
              generator_public_key, status, amount_planck, batch_id, created_at,
              orphaned_at
         FROM block_rewards WHERE block_id = ?1`,
    )
    .get(blockId) as Record<string, unknown> | null;
  return row ? toBlockRewardRow(row) : undefined;
}

/**
 * Every row recorded at a height that a reorg has not already invalidated.
 *
 * Plural because the table is keyed by block id, not by height: after a reorg
 * the losing block and its replacement both have a row at the same height, and
 * telling them apart is precisely the audit's job.
 */
export function activeBlockRewardsAtHeight(db: Ledger, height: number): BlockRewardRow[] {
  const rows = db
    .query(
      `SELECT block_id, height, block_timestamp, chain_day, generator_id,
              generator_public_key, status, amount_planck, batch_id, created_at,
              orphaned_at
         FROM block_rewards WHERE height = ?1 AND status != 'orphaned'`,
    )
    .all(height) as Record<string, unknown>[];
  return rows.map(toBlockRewardRow);
}

/**
 * Every live row above a height.
 *
 * The query a rewind asks: the node has fewer blocks than it did, and these are
 * the accruals recorded on the part that is gone.
 */
export function activeBlockRewardsAbove(db: Ledger, height: number): BlockRewardRow[] {
  const rows = db
    .query(
      `SELECT block_id, height, block_timestamp, chain_day, generator_id,
              generator_public_key, status, amount_planck, batch_id, created_at,
              orphaned_at
         FROM block_rewards WHERE height > ?1 AND status != 'orphaned'
        ORDER BY height`,
    )
    .all(height) as Record<string, unknown>[];
  return rows.map(toBlockRewardRow);
}

/**
 * Invalidates one block's accrual after a reorg.
 *
 * The amount is left on the row rather than zeroed: every sum in this file
 * already filters on status = 'accrued', so the rollback is complete the moment
 * the status changes, and keeping the number is what lets the status page say
 * how much a reorg cost an account instead of showing a silent gap.
 *
 * @returns true if this call was the one that orphaned it.
 */
export function markBlockOrphaned(db: Ledger, blockId: string, atEpochSeconds: number): boolean {
  const result = db
    .query(
      `UPDATE block_rewards SET status = 'orphaned', orphaned_at = ?1
        WHERE block_id = ?2 AND status != 'orphaned'`,
    )
    .run(atEpochSeconds, blockId);
  return result.changes === 1;
}

export function sumAccruedForAccountOnDay(
  db: Ledger,
  generatorId: string,
  chainDay: ChainDay,
): Amount {
  const row = db
    .query(
      `SELECT COALESCE(SUM(amount_planck), 0) AS total
         FROM block_rewards
        WHERE generator_id = ?1 AND chain_day = ?2 AND status = 'accrued'`,
    )
    .get(generatorId, chainDay) as { total: number };
  return fromPlanckInt(row.total);
}

export function sumAccruedGlobalOnDay(db: Ledger, chainDay: ChainDay): Amount {
  const row = db
    .query(
      `SELECT COALESCE(SUM(amount_planck), 0) AS total
         FROM block_rewards WHERE chain_day = ?1 AND status = 'accrued'`,
    )
    .get(chainDay) as { total: number };
  return fromPlanckInt(row.total);
}

export function countByStatus(db: Ledger): Partial<Record<BlockRewardStatus, number>> {
  const rows = db
    .query("SELECT status, COUNT(*) AS c FROM block_rewards GROUP BY status")
    .all() as { status: BlockRewardStatus; c: number }[];
  const out: Partial<Record<BlockRewardStatus, number>> = {};
  for (const r of rows) out[r.status] = r.c;
  return out;
}

export function getLastProcessedHeight(db: Ledger): number | undefined {
  const row = db.query("SELECT MAX(height) AS h FROM block_rewards").get() as {
    h: number | null;
  };
  return row.h ?? undefined;
}

export interface IndexedBlock {
  height: number;
  blockId: string;
  generatorId: string;
  blockTimestamp: number;
}

/**
 * The highest block this service has processed.
 *
 * Distinct from the node's head: the indexer deliberately trails by
 * BLOCK_OFFSET, and the gap between the two is what shows whether it is keeping
 * up. Reported from the ledger so it stays true even while the node is silent.
 */
export function lastIndexedBlock(db: Ledger): IndexedBlock | undefined {
  const row = db
    .query(
      `SELECT height, block_id AS blockId, generator_id AS generatorId,
              block_timestamp AS blockTimestamp
         FROM block_rewards WHERE status != 'orphaned'
        ORDER BY height DESC LIMIT 1`,
    )
    .get() as IndexedBlock | null;
  return row ?? undefined;
}
