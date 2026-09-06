import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import {
  aggregateUnpaidByRecipient,
  claimBatch,
  releaseBatch,
  getBatch,
  EmptyClaimError,
  markBroadcast,
  markConfirming,
  markConfirmed,
  liveBatch,
  recordAttempt,
  sumBroadcastSinceWallClock,
} from "../../src/ledger/batches.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

const accrue = (blockId: string, generatorId: string, signa: string) =>
  recordBlockReward(db, {
    blockId,
    height: Number(blockId.replace(/\D/g, "")) || 1,
    blockTimestamp: 500_000,
    chainDay: "2026-03-14",
    generatorId,
    generatorPublicKey: `pk-${generatorId}`,
    status: "accrued",
    amount: Amount.fromSigna(signa),
  });

describe("aggregateUnpaidByRecipient", () => {
  test("sums unpaid accruals per recipient", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-1", "2.5");
    accrue("b3", "acct-2", "2.5");
    const byId = new Map(aggregateUnpaidByRecipient(db).map((r) => [r.recipientId, r]));
    expect(byId.get("acct-1")?.amount.getSigna()).toBe("5");
    expect(byId.get("acct-1")?.accrualCount).toBe(2);
    expect(byId.get("acct-2")?.amount.getSigna()).toBe("2.5");
  });

  test("excludes skipped blocks", () => {
    accrue("b1", "acct-1", "2.5");
    recordBlockReward(db, {
      blockId: "b2",
      height: 2,
      blockTimestamp: 1,
      chainDay: "2026-03-14",
      generatorId: "acct-1",
      generatorPublicKey: "pk",
      status: "skipped_account_cap",
      amount: Amount.Zero(),
    });
    expect(aggregateUnpaidByRecipient(db)[0]?.amount.getSigna()).toBe("2.5");
  });

  test("returns an empty array when there is nothing to pay", () => {
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
  });
});

describe("claimBatch", () => {
  test("creates a batch and stamps the claimed accruals", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-1", "2.5");
    accrue("b3", "acct-2", "10");
    const claimed = claimBatch(db, { recipientIds: ["acct-1", "acct-2"], deadlineAt: 999 });
    expect(claimed.total.getSigna()).toBe("15");
    expect(claimed.recipients).toHaveLength(2);
    // "claimed" is pre-send: the accruals are stamped but nothing has been broadcast.
    expect(getBatch(db, claimed.batchId)?.status).toBe("claimed");
  });

  test("EXCLUSIVITY: claimed accruals disappear from the unpaid pool", () => {
    accrue("b1", "acct-1", "2.5");
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 });
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
  });

  test("EXCLUSIVITY: a second claim cannot take the same accruals", () => {
    accrue("b1", "acct-1", "2.5");
    const first = claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 });
    expect(first.total.getSigna()).toBe("2.5");
    expect(() => claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 })).toThrow(
      EmptyClaimError,
    );
  });

  test("claims only the named recipients, leaving others unpaid", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-2", "2.5");
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 });
    const remaining = aggregateUnpaidByRecipient(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.recipientId).toBe("acct-2");
  });

  test("throws rather than creating an empty batch", () => {
    expect(() => claimBatch(db, { recipientIds: [], deadlineAt: 999 })).toThrow(EmptyClaimError);
    const count = db.query("SELECT COUNT(*) AS c FROM batches").get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("ATOMICITY: a failed claim leaves no batch and no stamped accruals", () => {
    accrue("b1", "acct-1", "2.5");
    expect(() => claimBatch(db, { recipientIds: ["ghost"], deadlineAt: 999 })).toThrow(
      EmptyClaimError,
    );
    const after = db.query("SELECT COUNT(*) AS c FROM batches").get() as { c: number };
    expect(after.c).toBe(0);
    expect(aggregateUnpaidByRecipient(db)).toHaveLength(1);
  });
});

describe("releaseBatch", () => {
  test("returns accruals to the unpaid pool and marks the batch failed", () => {
    accrue("b1", "acct-1", "2.5");
    const claimed = claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 });
    releaseBatch(db, claimed.batchId, "deadline expired with no matching transaction");
    expect(getBatch(db, claimed.batchId)?.status).toBe("failed");
    const pool = aggregateUnpaidByRecipient(db);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.amount.getSigna()).toBe("2.5");
  });
});

describe("batch lifecycle", () => {
  const claimOne = () => {
    recordBlockReward(db, {
      blockId: "lc1", height: 40, blockTimestamp: 500_000, chainDay: "2026-03-14",
      generatorId: "acct-lc", generatorPublicKey: "pk", status: "accrued",
      amount: Amount.fromSigna("12"),
    });
    return claimBatch(db, { recipientIds: ["acct-lc"], deadlineAt: 1_800_001_800 });
  };

  test("markBroadcast records the transaction and the host that accepted it", () => {
    const { batchId } = claimOne();
    markBroadcast(db, batchId, {
      txId: "tx-1", fullHash: "hash-1", host: "https://europe.signum.network",
      feePlanck: 1_000_000, broadcastAt: 1_800_000_100,
    });

    const row = getBatch(db, batchId)!;
    expect(row.status).toBe("pending");
    expect(row.txId).toBe("tx-1");
    // The host is the point: every later check must go back to the same node.
    expect(row.broadcastHost).toBe("https://europe.signum.network");
    expect(row.broadcastAt).toBe(1_800_000_100);
  });

  test("markConfirming then markConfirmed walks the batch to settled", () => {
    const { batchId } = claimOne();
    markBroadcast(db, batchId, {
      txId: "tx-2", fullHash: "h", host: "h1", feePlanck: 1, broadcastAt: 1,
    });

    markConfirming(db, batchId, 1_000_500);
    expect(getBatch(db, batchId)?.status).toBe("confirming");

    markConfirmed(db, batchId, { confirmedAt: 1_800_000_900, height: 1_000_500 });
    const row = getBatch(db, batchId)!;
    expect(row.status).toBe("confirmed");
    expect(row.confirmedAt).toBe(1_800_000_900);
    expect(row.confirmedHeight).toBe(1_000_500);
  });

  test("liveBatch reports work still owed and nothing once terminal", () => {
    expect(liveBatch(db)).toBeUndefined();

    const { batchId } = claimOne();
    expect(liveBatch(db)?.id).toBe(batchId);

    markBroadcast(db, batchId, {
      txId: "tx-3", fullHash: "h", host: "h1", feePlanck: 1, broadcastAt: 1,
    });
    expect(liveBatch(db)?.id).toBe(batchId);

    markConfirmed(db, batchId, { confirmedAt: 2, height: 3 });
    expect(liveBatch(db)).toBeUndefined();
  });

  test("a released batch is not live and frees its accruals", () => {
    const { batchId } = claimOne();
    releaseBatch(db, batchId, "deadline expired");

    expect(liveBatch(db)).toBeUndefined();
    expect(getBatch(db, batchId)?.status).toBe("failed");
    // Back in the pool, so the next cycle re-composes them.
    expect(aggregateUnpaidByRecipient(db).some((a) => a.recipientId === "acct-lc")).toBe(true);
  });

  test("recordAttempt counts failures without changing status", () => {
    const { batchId } = claimOne();
    recordAttempt(db, batchId, "node rejected");
    recordAttempt(db, batchId, "node rejected again");

    const row = getBatch(db, batchId)!;
    expect(row.attemptCount).toBe(2);
    expect(row.lastError).toBe("node rejected again");
    expect(row.status).toBe("claimed");
  });

  test("the daily rail counts mempool spend, not only settled batches", () => {
    // A transaction in the mempool is money already committed. Leaving it out
    // would let the rail authorise a second batch on top of it.
    const { batchId } = claimOne();
    // claimBatch stamps created_at from the real clock, so the window has to be
    // anchored to the row rather than to a fixed constant.
    const day = getBatch(db, batchId)!.createdAt;

    expect(sumBroadcastSinceWallClock(db, day).getSigna()).toBe("0");

    markBroadcast(db, batchId, {
      txId: "tx-4", fullHash: "h", host: "h1", feePlanck: 1, broadcastAt: day + 10,
    });
    expect(sumBroadcastSinceWallClock(db, day).getSigna()).toBe("12");
  });

  test("a claimed batch does not count toward the daily rail", () => {
    // Nothing has been sent yet, so counting it would inflate the day's spend
    // for a batch that may still be released.
    const { batchId } = claimOne();
    expect(sumBroadcastSinceWallClock(db, getBatch(db, batchId)!.createdAt).getSigna()).toBe("0");
  });
});
