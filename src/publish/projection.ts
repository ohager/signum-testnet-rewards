import type { Amount } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { BlockRewardStatus, ChainDay } from "../domain/types.ts";
import { toPlanckInt } from "../domain/money.ts";
import { sumAccruedGlobalOnDay } from "../ledger/blockRewards.ts";
import { listRecentBatches } from "../ledger/batches.ts";
import { listOpenAlerts } from "../ledger/alerts.ts";
import { isPayoutsPaused, isKillSwitchTripped } from "../ledger/state.ts";

export interface MinerRow {
  accountId: string;
  blocksMined: number;
  blocksSkipped: number;
  pendingPlanck: number;
  paidPlanck: number;
  lastBlockAt: number | null;
  lastSkipReason: BlockRewardStatus | null;
}

export interface StatusRow {
  updatedAt: number;
  payoutsPaused: boolean;
  killSwitch: boolean;
  budgetRemainingPlanck: number;
  totalDistributedPlanck: number;
  openAlerts: string[];
}

export interface PayoutRow {
  batchId: number;
  txId: string | null;
  confirmedAt: number | null;
  recipientCount: number | null;
  totalPlanck: number | null;
}

export interface Projection {
  status: StatusRow;
  miners: MinerRow[];
  payouts: PayoutRow[];
}

export interface ProjectionOptions {
  nowEpochSeconds: number;
  chainDay: ChainDay;
  recentPayoutLimit: number;
  globalDailyBudget?: Amount;
}

/**
 * Builds the public read-model from ledger state.
 *
 * Amounts leave as planck integers rather than Amount objects: this crosses a
 * JSON and SQL boundary, and an exact integer survives both without needing a
 * serialisation contract.
 *
 * Consumed by BOTH the Turso publisher and the admin UI, so a new statistic is
 * added once and appears on both surfaces.
 */
export function buildProjection(db: Ledger, opts: ProjectionOptions): Projection {
  const minerRows = db
    .query(
      `SELECT generator_id AS accountId,
              SUM(CASE WHEN status = 'accrued' THEN 1 ELSE 0 END)  AS blocksMined,
              SUM(CASE WHEN status <> 'accrued' THEN 1 ELSE 0 END) AS blocksSkipped,
              COALESCE(SUM(CASE WHEN status = 'accrued' AND batch_id IS NULL
                                THEN amount_planck ELSE 0 END), 0) AS pendingPlanck,
              COALESCE(SUM(CASE WHEN status = 'accrued' AND batch_id IS NOT NULL
                                THEN amount_planck ELSE 0 END), 0) AS paidPlanck,
              MAX(block_timestamp)                                 AS lastBlockAt
         FROM block_rewards
        GROUP BY generator_id`,
    )
    .all() as Omit<MinerRow, "lastSkipReason">[];

  const skipStmt = db.query(
    `SELECT status FROM block_rewards
      WHERE generator_id = ?1 AND status <> 'accrued'
      ORDER BY height DESC LIMIT 1`,
  );

  const miners: MinerRow[] = minerRows.map((m) => {
    const skip = skipStmt.get(m.accountId) as { status: BlockRewardStatus } | null;
    return { ...m, lastSkipReason: skip?.status ?? null };
  });

  const totalDistributedPlanck = (
    db
      .query(
        `SELECT COALESCE(SUM(amount_planck), 0) AS total
           FROM block_rewards WHERE status = 'accrued' AND batch_id IS NOT NULL`,
      )
      .get() as { total: number }
  ).total;

  const spentToday = sumAccruedGlobalOnDay(db, opts.chainDay);
  const budgetRemainingPlanck = opts.globalDailyBudget
    ? toPlanckInt(opts.globalDailyBudget.clone().subtract(spentToday))
    : 0;

  const payouts: PayoutRow[] = listRecentBatches(db, opts.recentPayoutLimit)
    .filter((b) => b.status === "confirmed")
    .map((b) => ({
      batchId: b.id,
      txId: b.txId,
      confirmedAt: null,
      recipientCount: b.recipientCount,
      totalPlanck: b.total ? toPlanckInt(b.total) : null,
    }));

  return {
    status: {
      updatedAt: opts.nowEpochSeconds,
      payoutsPaused: isPayoutsPaused(db),
      killSwitch: isKillSwitchTripped(db),
      budgetRemainingPlanck,
      totalDistributedPlanck,
      openAlerts: listOpenAlerts(db).map((a) => a.kind),
    },
    miners,
    payouts,
  };
}
