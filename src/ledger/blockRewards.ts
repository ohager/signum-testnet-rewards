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
}

/**
 * Records the outcome of one observed block.
 *
 * INSERT OR IGNORE against the block_id primary key is the first of the two
 * idempotency layers: the chain walker's JSON cache and this database are
 * separate files that can disagree after a crash, so the walker may replay
 * blocks. A replay must be a silent no-op rather than a second accrual.
 *
 * @returns true if a new row was inserted, false if this block was already recorded.
 */
export function recordBlockReward(db: Ledger, input: BlockRewardInput): boolean {
  const result = db
    .query(
      `INSERT OR IGNORE INTO block_rewards
         (block_id, height, block_timestamp, chain_day, generator_id,
          generator_public_key, status, amount_planck, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
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

export function getBlockReward(db: Ledger, blockId: string): BlockRewardRow | undefined {
  const row = db
    .query(
      `SELECT block_id, height, block_timestamp, chain_day, generator_id,
              generator_public_key, status, amount_planck, batch_id, created_at
         FROM block_rewards WHERE block_id = ?1`,
    )
    .get(blockId) as Record<string, unknown> | null;
  if (!row) return undefined;
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
  };
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
