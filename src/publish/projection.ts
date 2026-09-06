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
import type { RewardPolicyConfig } from "../domain/policy.ts";

const planckOrNull = (amount: Amount | undefined): number | null =>
  amount === undefined ? null : toPlanckInt(amount);

const toEpochSeconds = (chainTimestamp: number): number =>
  Math.floor(ChainTime.fromChainTimestamp(chainTimestamp).getDate().getTime() / 1000);

/**
 * Whether the same account exists on mainnet with a public key set.
 *
 * `unknown` is a real third case, not a placeholder: the lookup cache is pruned
 * by retention, so a miner who stopped forging long ago loses their entry.
 * Reporting that as "no mainnet account" would accuse someone of being
 * unpayable on the strength of a cache miss.
 */
export type MainnetAccountState = "active" | "inactive" | "unknown";

export interface MinerRow {
  accountId: string;
  /** The same account in the form a person can check against an explorer. */
  accountRS: string;
  /** Payable only when "active": this is the eligibility gate, shown per miner. */
  mainnetAccount: MainnetAccountState;
  blocksMined: number;
  blocksSkipped: number;
  pendingPlanck: number;
  paidPlanck: number;
  /** Epoch seconds, converted from chain time so nothing downstream handles both. */
  lastBlockAt: number | null;
  lastSkipReason: BlockRewardStatus | null;
}

/**
 * The testnet head as the health probe last described it.
 *
 * A narrow copy of the probe's `HeadBlock` rather than an import of it: the
 * projection has no business knowing about generation signatures or observation
 * timestamps, and the published page shows a chain that is moving, not a chain
 * that is being diagnosed.
 */
export interface ChainHeadRow {
  height: number;
  generatorId: string;
  /** The forger in the form a person recognises. */
  generatorRS: string;
  /** Epoch seconds. Ages on its own, so no observation time is needed with it. */
  forgedAt: number;
}

export interface StatusRow {
  updatedAt: number;
  payoutsEnabled: boolean;
  payoutsPaused: boolean;
  killSwitch: boolean;
  /** Left of today's allowance, never negative. Null when no budget is configured. */
  budgetRemainingPlanck: number | null;
  /**
   * What today's accruals have consumed of the allowance, budget or not.
   *
   * Counted at accrual, so it INCLUDES amounts already paid out — paying an
   * accrual does not hand the day's budget back. That makes it the honest
   * partner to `budgetRemainingPlanck`, and the only figure that still moves
   * when no ceiling is configured.
   */
  spentTodayPlanck: number;
  /**
   * The rules a block is judged against, republished with every status row.
   *
   * Carried here rather than left to the reader's imagination because the
   * figures they explain are otherwise unreadable: a miner who sees 10 rewarded
   * blocks and 122 skipped ones can only make sense of that pair once they know
   * the per-block reward and the daily cap that stopped the eleventh.
   *
   * Null when the caller publishes no rules, which is a different statement
   * from a rule of zero — see `budgetRemainingPlanck`.
   */
  rewardPerBlockPlanck: number | null;
  accountDailyCapPlanck: number | null;
  globalDailyBudgetPlanck: number | null;
  /** Below this an accrual waits for a later batch rather than being sent. */
  minPayoutPlanck: number | null;
  /**
   * The testnet head, published so the page can show the chain moving rather
   * than only the money it produces. Null until a probe has described a block.
   */
  testnetHeight: number | null;
  lastForgerId: string | null;
  lastForgerRS: string | null;
  /** Epoch seconds the head block was forged. */
  lastBlockForgedAt: number | null;
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
  /**
   * The reward rules in force. Absent means none are published: the daily
   * ceiling then shows as unlimited and the public page explains the programme
   * without quoting figures it was not given.
   */
  policy?: RewardPolicyConfig;
  /** The dust threshold a batch composes against. Published alongside `policy`. */
  minPayout?: Amount;
  /** Absent until the health probe has described a head block at least once. */
  chainHead?: ChainHeadRow;
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
              MAX(block_timestamp)                                 AS lastBlockAt,
              MAX(ma.is_active)                                    AS mainnetIsActive
         FROM block_rewards br
         LEFT JOIN mainnet_accounts ma ON ma.account_id = br.generator_id
        GROUP BY generator_id
        ORDER BY pendingPlanck DESC, paidPlanck DESC, generator_id`,
    )
    .all() as (Omit<MinerRow, "lastSkipReason" | "accountRS" | "mainnetAccount"> & {
      mainnetIsActive: number | null;
    })[];

  const skipStmt = db.query(
    `SELECT status FROM block_rewards
      WHERE generator_id = ?1 AND status <> 'accrued'
      ORDER BY height DESC LIMIT 1`,
  );

  const allMiners: MinerRow[] = minerRows.map((m) => {
    const skip = skipStmt.get(m.accountId) as { status: BlockRewardStatus } | null;
    const { mainnetIsActive, ...row } = m;
    return {
      ...row,
      accountRS: toReedSolomon(m.accountId),
      mainnetAccount:
        mainnetIsActive === null ? "unknown" : mainnetIsActive === 1 ? "active" : "inactive",
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

  // Clamped at zero because the remainder can go negative when an operator
  // lowers the budget below what the day has already accrued: the caps only
  // ever guarded accruals against the budget in force at the time. A negative
  // allowance is not something anyone can act on, and it would render as a
  // headline figure implying the programme owes the budget money.
  const spentToday = sumAccruedGlobalOnDay(db, opts.chainDay);
  const globalDailyBudget = opts.policy?.globalDailyBudget;
  const budgetRemainingPlanck =
    globalDailyBudget === undefined
      ? null
      : Math.max(0, toPlanckInt(globalDailyBudget.clone().subtract(spentToday)));

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
      spentTodayPlanck: toPlanckInt(spentToday),
      rewardPerBlockPlanck: planckOrNull(opts.policy?.rewardPerBlock),
      accountDailyCapPlanck: planckOrNull(opts.policy?.accountDailyCap),
      globalDailyBudgetPlanck: planckOrNull(globalDailyBudget),
      minPayoutPlanck: planckOrNull(opts.minPayout),
      testnetHeight: opts.chainHead?.height ?? null,
      lastForgerId: opts.chainHead?.generatorId ?? null,
      lastForgerRS: opts.chainHead?.generatorRS ?? null,
      lastBlockForgedAt: opts.chainHead?.forgedAt ?? null,
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
