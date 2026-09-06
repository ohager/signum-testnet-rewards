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
    expect(getBatch(db, claimed.batchId)?.status).toBe("pending");
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
