import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { claimBatch } from "../../src/ledger/batches.ts";
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

const opts = { nowEpochSeconds: 1_800_000_000, chainDay: "2026-03-14", recentPayoutLimit: 20 };

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
