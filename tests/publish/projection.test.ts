import { test, expect, describe, beforeEach } from "bun:test";
import { Amount, ChainTime } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { claimBatch } from "../../src/ledger/batches.ts";
import { tripKillSwitch, setPayoutsPaused } from "../../src/ledger/state.ts";
import { upsertAccount } from "../../src/ledger/mainnetAccounts.ts";
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

/** The reward rules, as the service passes them in. Budget varies per test. */
const policyWith = (budgetSigna: string) => ({
  rewardPerBlock: Amount.fromSigna("1"),
  accountDailyCap: Amount.fromSigna("10"),
  globalDailyBudget: Amount.fromSigna(budgetSigna),
});

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
      ...opts, policy: policyWith("1000"),
    });
    expect(projection.status.budgetRemainingPlanck).toBe(99_750_000_000);
  });

  // Reachable by lowering the budget mid-day below what has already accrued:
  // the caps only guard accruals made under the budget in force at the time.
  test("clamps the remaining budget at zero rather than reporting a debt", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-2", "2.5");
    const projection = buildProjection(db, {
      ...opts, policy: policyWith("1"),
    });
    expect(projection.status.budgetRemainingPlanck).toBe(0);
  });

  // Null is "no ceiling", which the page renders as unlimited. Publishing zero
  // would be indistinguishable from a budget spent down to nothing.
  test("reports no budget at all as null, not as nothing left", () => {
    accrue("b1", "acct-1", "2.5");
    expect(buildProjection(db, opts).status.budgetRemainingPlanck).toBeNull();
  });

  test("reports what today has consumed alongside what is left", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-2", "2.5");
    const status = buildProjection(db, {
      ...opts, policy: policyWith("1000"),
    }).status;
    expect(status.spentTodayPlanck).toBe(500_000_000);
    expect(status.budgetRemainingPlanck).toBe(99_500_000_000);
  });

  // The budget is consumed at accrual, so paying an accrual out does not give
  // the day's allowance back. Reading the two cards together must not suggest
  // otherwise.
  test("counts an accrual that has already been paid as spent", () => {
    accrue("b1", "acct-1", "2.5");
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 1 });
    expect(buildProjection(db, opts).status.spentTodayPlanck).toBe(250_000_000);
  });

  test("counts only today: yesterday's accruals do not consume today's budget", () => {
    recordBlockReward(db, {
      blockId: "old", height: 1, blockTimestamp: 400_000, chainDay: "2026-03-13",
      generatorId: "acct-1", generatorPublicKey: "pk-acct-1",
      status: "accrued", amount: Amount.fromSigna("2.5"),
    });
    accrue("b1", "acct-1", "2.5");
    expect(buildProjection(db, opts).status.spentTodayPlanck).toBe(250_000_000);
  });

  test("a skipped block consumes none of the budget", () => {
    accrue("b1", "acct-1", "0", "skipped_global_cap");
    expect(buildProjection(db, opts).status.spentTodayPlanck).toBe(0);
  });

  // With no ceiling there is nothing to subtract from, but the day's spend is
  // still a real figure and the page still shows it.
  test("reports the day's spend even when no budget is configured", () => {
    accrue("b1", "acct-1", "2.5");
    const status = buildProjection(db, opts).status;
    expect(status.budgetRemainingPlanck).toBeNull();
    expect(status.spentTodayPlanck).toBe(250_000_000);
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

  // The public page quotes these back to miners to explain why a forged block
  // earned nothing, so they travel with every status row rather than being
  // duplicated into the site's own configuration.
  test("publishes the reward rules in force", () => {
    const status = buildProjection(db, {
      ...opts, policy: policyWith("1000"), minPayout: Amount.fromSigna("5"),
    }).status;
    expect(status.rewardPerBlockPlanck).toBe(100_000_000);
    expect(status.accountDailyCapPlanck).toBe(1_000_000_000);
    expect(status.globalDailyBudgetPlanck).toBe(100_000_000_000);
    expect(status.minPayoutPlanck).toBe(500_000_000);
  });

  // Null means "not published", which the page answers with prose instead of
  // figures. Zero would read as a programme that pays nothing.
  test("reports unpublished rules as null rather than zero", () => {
    const status = buildProjection(db, opts).status;
    expect(status.rewardPerBlockPlanck).toBeNull();
    expect(status.accountDailyCapPlanck).toBeNull();
    expect(status.globalDailyBudgetPlanck).toBeNull();
    expect(status.minPayoutPlanck).toBeNull();
  });

  // The head is in memory in the health monitor, never in the ledger, so it can
  // only reach the page by being handed to the projection.
  test("publishes the testnet head it is given", () => {
    const status = buildProjection(db, {
      ...opts,
      chainHead: {
        height: 1_204_331,
        generatorId: "acct-9",
        generatorRS: "TS-ACCT-0009",
        forgedAt: 1_799_999_880,
      },
    }).status;
    expect(status.testnetHeight).toBe(1_204_331);
    expect(status.lastForgerId).toBe("acct-9");
    expect(status.lastForgerRS).toBe("TS-ACCT-0009");
    expect(status.lastBlockForgedAt).toBe(1_799_999_880);
  });

  // Every probe can fail, and the service starts before the first one answers.
  test("reports an unobserved head as null", () => {
    const status = buildProjection(db, opts).status;
    expect(status.testnetHeight).toBeNull();
    expect(status.lastForgerId).toBeNull();
    expect(status.lastForgerRS).toBeNull();
    expect(status.lastBlockForgedAt).toBeNull();
  });

  test("MUTATION SAFETY: the budget Amount passed in is not modified", () => {
    accrue("b1", "acct-1", "2.5");
    const budget = Amount.fromSigna("1000");
    buildProjection(db, {
      ...opts,
      policy: { ...policyWith("1000"), globalDailyBudget: budget },
    });
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

describe("an overdue cycle that cannot pay anyone", () => {
  // The window elapsed a day ago. Whether that reads as "due" now depends
  // entirely on whether anyone clears the minimum.
  const overdue = {
    ...opts,
    payouts: { ...payouts, serviceStartedAt: opts.nowEpochSeconds - 30 * 3_600 },
    minPayout: Amount.fromSigna("5"),
  };

  test("is due when a miner clears the minimum", () => {
    accrue("b1", "acct-1", "5");
    expect(buildProjection(db, overdue).status.payoutState).toBe("due");
  });

  test("IS POSTPONED, NOT DUE, WHEN EVERY BALANCE IS DUST", () => {
    accrue("b1", "acct-1", "4");
    accrue("b2", "acct-2", "4");
    expect(buildProjection(db, overdue).status.payoutState).toBe("postponed");
  });

  test("stays postponed however much is owed in total", () => {
    // 40 SIGNA outstanding, eight times the minimum, and not one payable miner.
    for (let i = 0; i < 10; i++) accrue(`b${i}`, `acct-${i}`, "4");

    const status = buildProjection(db, overdue).status;
    expect(status.pendingPlanck).toBe(4_000_000_000);
    expect(status.payoutState).toBe("postponed");
  });

  test("the elapsed time is still published while postponed", () => {
    accrue("b1", "acct-1", "4");

    const status = buildProjection(db, overdue).status;
    expect(status.nextPayoutAt).toBe(opts.nowEpochSeconds - 24 * 3_600);
    expect(status.payoutBlockedBy).toBeNull();
  });

  test("a cycle whose window has not elapsed is pending, dust or not", () => {
    accrue("b1", "acct-1", "4");
    expect(buildProjection(db, { ...opts, minPayout: Amount.fromSigna("5") }).status.payoutState)
      .toBe("pending");
  });

  test("WITH NO MINIMUM CONFIGURED, ANY OUTSTANDING ACCRUAL IS PAYABLE", () => {
    accrue("b1", "acct-1", "0.1");
    expect(buildProjection(db, { ...overdue, minPayout: undefined }).status.payoutState)
      .toBe("due");
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

describe("mainnet account state per miner", () => {
  // The eligibility gate already runs on every block; this only surfaces it, so
  // a miner can see WHY they are forging without being paid.
  test("a miner with an active mainnet account is payable", () => {
    accrue("b1", "acct-1", "2.5");
    upsertAccount(db, { accountId: "acct-1", publicKey: "pk", isActive: true }, 1_800_000_000);

    expect(buildProjection(db, opts).miners[0]!.mainnetAccount).toBe("active");
  });

  test("a miner without one is flagged inactive rather than merely unpaid", () => {
    accrue("b1", "acct-1", "2.5", "skipped_no_mainnet_account");
    upsertAccount(db, { accountId: "acct-1", publicKey: null, isActive: false }, 1_800_000_000);

    expect(buildProjection(db, opts).miners[0]!.mainnetAccount).toBe("inactive");
  });

  test("A CACHE MISS IS UNKNOWN, NOT AN ACCUSATION", () => {
    // Retention prunes the lookup cache, so a long-idle miner loses their entry.
    // Reporting that as "no mainnet account" would claim they are unpayable on
    // the strength of a missing row.
    accrue("b1", "never-checked", "2.5");

    expect(buildProjection(db, opts).miners[0]!.mainnetAccount).toBe("unknown");
  });

  test("the state does not disturb the pending ranking", () => {
    accrue("b1", "small", "2.5");
    accrue("b2", "big", "2.5");
    accrue("b3", "big", "2.5");
    upsertAccount(db, { accountId: "small", publicKey: "pk", isActive: true }, 1_800_000_000);

    const miners = buildProjection(db, opts).miners;
    expect(miners.map((m) => m.accountId)).toEqual(["big", "small"]);
    expect(miners.map((m) => m.mainnetAccount)).toEqual(["unknown", "active"]);
  });

  test("one cached lookup covers every block that miner forged", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-1", "2.5");
    upsertAccount(db, { accountId: "acct-1", publicKey: "pk", isActive: true }, 1_800_000_000);

    const miners = buildProjection(db, opts).miners;
    expect(miners).toHaveLength(1);
    expect(miners[0]!.blocksMined).toBe(2);
    expect(miners[0]!.mainnetAccount).toBe("active");
  });
});
