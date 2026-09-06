import type { Amount } from "@signumjs/util";
import { ChainTime } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { BlockRewardStatus, ChainDay } from "../domain/types.ts";
import { toPlanckInt } from "../domain/money.ts";
import { sumAccruedGlobalOnDay } from "../ledger/blockRewards.ts";
import { listRecentBatches } from "../ledger/batches.ts";
import { listOpenAlerts } from "../ledger/alerts.ts";
import { isPayoutsPaused, isKillSwitchTripped } from "../ledger/state.ts";
import { toReedSolomon } from "../domain/address.ts";
import { lastBatchCreatedAt } from "../ledger/batches.ts";
import { computePayoutSchedule } from "../payout/schedule.ts";
import type { PayoutBlocker } from "../payout/schedule.ts";

const toEpochSeconds = (chainTimestamp: number): number =>
  Math.floor(ChainTime.fromChainTimestamp(chainTimestamp).getDate().getTime() / 1000);

export interface MinerRow {
  accountId: string;
  /** The same account in the form a person can check against an explorer. */
  accountRS: string;
  blocksMined: number;
  blocksSkipped: number;
  pendingPlanck: number;
  paidPlanck: number;
  /** Epoch seconds, converted from chain time so nothing downstream handles both. */
  lastBlockAt: number | null;
  lastSkipReason: BlockRewardStatus | null;
}

export interface StatusRow {
  updatedAt: number;
  payoutsEnabled: boolean;
  payoutsPaused: boolean;
  killSwitch: boolean;
  budgetRemainingPlanck: number;
  totalDistributedPlanck: number;
  /** Total still owed to miners across every account. */
  pendingPlanck: number;
  /**
   * How many miners the `miners` table holds.
   *
   * Carried on the status row so a public page can render its headline from a
   * SINGLE row read, instead of counting a table it does not otherwise need.
   */
  minerCount: number;
  /** Epoch seconds of the next payout cycle. Null exactly when blocked. */
  nextPayoutAt: number | null;
  /** Set only when there is no next payout: why not. */
  payoutBlockedBy: PayoutBlocker | null;
  /** The next payout is already overdue. */
  payoutDue: boolean;
  lastPayoutAt: number | null;
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

export interface PayoutScheduleOptions {
  enabled: boolean;
  intervalSeconds: number;
  /** Anchors the schedule until the first batch has ever run. */
  serviceStartedAt: number;
}

export interface ProjectionOptions {
  nowEpochSeconds: number;
  chainDay: ChainDay;
  recentPayoutLimit: number;
  payouts: PayoutScheduleOptions;
  /**
   * Epoch seconds. Miners with no block since then AND nothing owed are left
   * out entirely.
   *
   * Undefined means no window, which is what the admin panel wants: it reads a
   * local database where a row costs nothing. The published projection passes a
   * real cutoff, because every row there is read again on every page view.
   */
  minerActivitySince?: number;
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
 * added once and appears on both surfaces. Miners come back ranked by what they
 * are owed, so neither surface has to re-sort to answer "who is waiting on the
 * most money".
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
        GROUP BY generator_id
        ORDER BY pendingPlanck DESC, paidPlanck DESC, generator_id`,
    )
    .all() as Omit<MinerRow, "lastSkipReason" | "accountRS">[];

  const skipStmt = db.query(
    `SELECT status FROM block_rewards
      WHERE generator_id = ?1 AND status <> 'accrued'
      ORDER BY height DESC LIMIT 1`,
  );

  const allMiners: MinerRow[] = minerRows.map((m) => {
    const skip = skipStmt.get(m.accountId) as { status: BlockRewardStatus } | null;
    return {
      ...m,
      accountRS: toReedSolomon(m.accountId),
      // getEpoch() returns MILLISECONDS despite its name; getDate() is the
      // unambiguous route to the seconds every other timestamp here uses.
      lastBlockAt: m.lastBlockAt === null ? null : toEpochSeconds(m.lastBlockAt),
      lastSkipReason: skip?.status ?? null,
    };
  });

  // Money owed always keeps a miner visible, however long they have been idle:
  // dropping someone still waiting to be paid would be indefensible.
  const since = opts.minerActivitySince;
  const miners =
    since === undefined
      ? allMiners
      : allMiners.filter((m) => m.pendingPlanck > 0 || (m.lastBlockAt ?? 0) >= since);

  const totalDistributedPlanck = (
    db
      .query(
        `SELECT COALESCE(SUM(amount_planck), 0) AS total
           FROM block_rewards WHERE status = 'accrued' AND batch_id IS NOT NULL`,
      )
      .get() as { total: number }
  ).total;

  const pendingPlanck = miners.reduce((sum, m) => sum + m.pendingPlanck, 0);

  const schedule = computePayoutSchedule({
    enabled: opts.payouts.enabled,
    paused: isPayoutsPaused(db),
    killSwitch: isKillSwitchTripped(db),
    lastRunAt: lastBatchCreatedAt(db),
    serviceStartedAt: opts.payouts.serviceStartedAt,
    intervalSeconds: opts.payouts.intervalSeconds,
    nowEpochSeconds: opts.nowEpochSeconds,
  });

  const spentToday = sumAccruedGlobalOnDay(db, opts.chainDay);
  const budgetRemainingPlanck = opts.globalDailyBudget
    ? toPlanckInt(opts.globalDailyBudget.clone().subtract(spentToday))
    : 0;

  const payouts: PayoutRow[] = listRecentBatches(db, opts.recentPayoutLimit)
    .filter((b) => b.status === "confirmed")
    .map((b) => ({
      batchId: b.id,
      txId: b.txId,
      confirmedAt: b.confirmedAt,
      recipientCount: b.recipientCount,
      totalPlanck: b.total ? toPlanckInt(b.total) : null,
    }));

  return {
    status: {
      updatedAt: opts.nowEpochSeconds,
      payoutsEnabled: opts.payouts.enabled,
      payoutsPaused: isPayoutsPaused(db),
      killSwitch: isKillSwitchTripped(db),
      budgetRemainingPlanck,
      totalDistributedPlanck,
      pendingPlanck,
      minerCount: miners.length,
      nextPayoutAt: schedule.nextRunAt ?? null,
      payoutBlockedBy: schedule.blockedBy ?? null,
      payoutDue: schedule.due,
      lastPayoutAt: schedule.lastRunAt ?? null,
      openAlerts: listOpenAlerts(db).map((a) => a.kind),
    },
    miners,
    payouts,
  };
}
