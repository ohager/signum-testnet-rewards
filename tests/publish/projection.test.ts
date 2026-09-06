import { test, expect, describe, beforeEach } from "bun:test";
import { Amount, ChainTime } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { claimBatch } from "../../src/ledger/batches.ts";
import { tripKillSwitch, setPayoutsPaused } from "../../src/ledger/state.ts";
import { buildProjection } from "../../src/publish/projection.ts";
import type { BlockRewardStatus } from "../../src/domain/types.ts";

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

const accrue = (
  blockId: string, generatorId: string, signa: string,
  status: BlockRewardStatus = "accrued",
) =>
  recordBlockReward(db, {
    blockId, height: Number(blockId.replace(/\D/g, "")) || 1,
    blockTimestamp: 500_000, chainDay: "2026-03-14",
    generatorId, generatorPublicKey: `pk-${generatorId}`,
    status, amount: Amount.fromSigna(signa),
  });

const payouts = {
  enabled: true,
  intervalSeconds: 6 * 3_600,
  serviceStartedAt: 1_800_000_000 - 3_600,
};

const opts = {
  nowEpochSeconds: 1_800_000_000,
  chainDay: "2026-03-14",
  recentPayoutLimit: 20,
  payouts,
};

describe("buildProjection", () => {
  test("summarises miners with paid and pending split out", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-1", "2.5");
    accrue("b3", "acct-2", "2.5");
    const miner = buildProjection(db, opts).miners.find((m) => m.accountId === "acct-1");
    expect(miner?.blocksMined).toBe(2);
    expect(miner?.pendingPlanck).toBe(500_000_000);
    expect(miner?.paidPlanck).toBe(0);
  });

  test("moves an accrual from pending to paid once it is claimed into a batch", () => {
    accrue("b1", "acct-1", "2.5");
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 1 });
    const miner = buildProjection(db, opts).miners.find((m) => m.accountId === "acct-1");
    expect(miner?.pendingPlanck).toBe(0);
    expect(miner?.paidPlanck).toBe(250_000_000);
  });

  test("counts skipped blocks separately and records the reason", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-1", "0", "skipped_no_mainnet_account");
    const miner = buildProjection(db, opts).miners.find((m) => m.accountId === "acct-1");
    expect(miner?.blocksMined).toBe(1);
    expect(miner?.blocksSkipped).toBe(1);
    expect(miner?.lastSkipReason).toBe("skipped_no_mainnet_account");
  });

  test("reports today's remaining budget", () => {
    accrue("b1", "acct-1", "2.5");
    const projection = buildProjection(db, {
      ...opts, globalDailyBudget: Amount.fromSigna("1000"),
    });
    expect(projection.status.budgetRemainingPlanck).toBe(99_750_000_000);
  });

  test("STALENESS: the status carries the timestamp the page checks", () => {
    expect(buildProjection(db, opts).status.updatedAt).toBe(opts.nowEpochSeconds);
  });

  test("amounts are emitted as planck integers, safe for JSON and SQL", () => {
    accrue("b1", "acct-1", "2.5");
    const miner = buildProjection(db, opts).miners.find((m) => m.accountId === "acct-1");
    expect(Number.isInteger(miner?.pendingPlanck)).toBe(true);
  });

  test("produces an empty but well-formed projection on a fresh ledger", () => {
    const projection = buildProjection(db, opts);
    expect(projection.miners).toEqual([]);
    expect(projection.payouts).toEqual([]);
    expect(projection.status.totalDistributedPlanck).toBe(0);
  });

  test("MUTATION SAFETY: the budget Amount passed in is not modified", () => {
    accrue("b1", "acct-1", "2.5");
    const budget = Amount.fromSigna("1000");
    buildProjection(db, { ...opts, globalDailyBudget: budget });
    expect(budget.getSigna()).toBe("1000");
  });
});

describe("payout schedule in the projection", () => {
  test("miners are ranked by what they are owed", () => {
    accrue("b1", "small", "2.5");
    accrue("b2", "big", "2.5");
    accrue("b3", "big", "2.5");

    const p = buildProjection(db, opts);
    expect(p.miners.map((m) => m.accountId)).toEqual(["big", "small"]);
  });

  test("pending across all miners is totalled for the status row", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-2", "10");

    expect(buildProjection(db, opts).status.pendingPlanck).toBe(1_250_000_000);
  });

  test("a claimed accrual leaves pending and lands in paid", () => {
    accrue("b1", "acct-1", "2.5");
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 0 });

    const p = buildProjection(db, opts);
    expect(p.status.pendingPlanck).toBe(0);
    expect(p.miners[0]!.paidPlanck).toBe(250_000_000);
  });

  test("the next payout is one interval after service start before any batch", () => {
    const status = buildProjection(db, opts).status;
    expect(status.nextPayoutAt).toBe(payouts.serviceStartedAt + payouts.intervalSeconds);
    expect(status.lastPayoutAt).toBeNull();
    expect(status.payoutBlockedBy).toBeNull();
  });

  test("the next payout follows the most recent batch once one exists", () => {
    accrue("b1", "acct-1", "2.5");
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 0 });

    const status = buildProjection(db, opts).status;
    expect(status.lastPayoutAt).not.toBeNull();
    expect(status.nextPayoutAt).toBe(status.lastPayoutAt! + payouts.intervalSeconds);
  });

  test("SHADOW MODE PROMISES NO PAYOUT: no time is published when disabled", () => {
    const status = buildProjection(db, {
      ...opts,
      payouts: { ...payouts, enabled: false },
    }).status;
    expect(status.payoutsEnabled).toBe(false);
    expect(status.nextPayoutAt).toBeNull();
    expect(status.payoutBlockedBy).toBe("disabled");
  });

  test("a tripped kill switch withdraws the promised time", () => {
    tripKillSwitch(db, "rail violation");

    const status = buildProjection(db, opts).status;
    expect(status.nextPayoutAt).toBeNull();
    expect(status.payoutBlockedBy).toBe("kill_switch");
  });

  test("a pause withdraws the promised time", () => {
    setPayoutsPaused(db, true);
    expect(buildProjection(db, opts).status.payoutBlockedBy).toBe("paused");
  });
});

describe("the published miner window", () => {
  // Every row published to Turso is read again on every uncached page view, so
  // the published projection is windowed while the admin panel stays complete.
  const RECENT = 1_800_000_000 - 86_400;
  const ANCIENT = 1_800_000_000 - 90 * 86_400;

  /** Records a block whose chain timestamp maps to the given epoch second. */
  const accrueAt = (blockId: string, generatorId: string, epochSeconds: number, signa = "2.5") =>
    recordBlockReward(db, {
      blockId, height: Number(blockId.replace(/\D/g, "")) || 1,
      blockTimestamp: ChainTime.fromDate(new Date(epochSeconds * 1000)).getChainTimestamp(),
      chainDay: "2026-03-14",
      generatorId, generatorPublicKey: `pk-${generatorId}`,
      status: "accrued", amount: Amount.fromSigna(signa),
    });

  test("lastBlockAt is published as epoch seconds, not chain time", () => {
    accrueAt("b1", "acct-1", RECENT);
    expect(buildProjection(db, opts).miners[0]!.lastBlockAt).toBe(RECENT);
  });

  test("an idle, fully paid miner is left out of the windowed view", () => {
    accrueAt("b1", "idle", ANCIENT);
    claimBatch(db, { recipientIds: ["idle"], deadlineAt: 0 });
    accrueAt("b2", "active", RECENT);

    const windowed = buildProjection(db, { ...opts, minerActivitySince: RECENT - 86_400 });
    expect(windowed.miners.map((m) => m.accountId)).toEqual(["active"]);
    expect(windowed.status.minerCount).toBe(1);
  });

  test("MONEY OWED KEEPS A MINER VISIBLE HOWEVER LONG THEY HAVE BEEN IDLE", () => {
    accrueAt("b1", "owed", ANCIENT);

    const windowed = buildProjection(db, { ...opts, minerActivitySince: RECENT });
    expect(windowed.miners.map((m) => m.accountId)).toEqual(["owed"]);
  });

  test("the admin view passes no window and keeps everyone", () => {
    accrueAt("b1", "idle", ANCIENT);
    claimBatch(db, { recipientIds: ["idle"], deadlineAt: 0 });

    expect(buildProjection(db, opts).miners).toHaveLength(1);
  });

  test("minerCount lets a page render its headline from one row read", () => {
    accrueAt("b1", "acct-1", RECENT);
    accrueAt("b2", "acct-2", RECENT);

    expect(buildProjection(db, opts).status.minerCount).toBe(2);
  });
});
