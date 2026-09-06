import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import {
  claimBatch, markBroadcast, getBatch, liveBatch, aggregateUnpaidByRecipient,
} from "../../src/ledger/batches.ts";
import { reconcileBatch } from "../../src/payout/reconcile.ts";
import type { MainnetPool, TransactionLookup } from "../../src/chain/mainnetPool.ts";

let db: Ledger;
const NOW = 1_800_000_000;
const DEADLINE = NOW + 1_800; // 30 minutes, matching TX_DEADLINE_MINUTES

beforeEach(() => {
  db = openLedger(":memory:");
  recordBlockReward(db, {
    blockId: "b1", height: 10, blockTimestamp: 500_000, chainDay: "2026-03-14",
    generatorId: "acct-1", generatorPublicKey: "pk", status: "accrued",
    amount: Amount.fromSigna("10"),
  });
});

const claim = () => claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: DEADLINE });

const broadcast = (batchId: number, host = "node-a") =>
  markBroadcast(db, batchId, {
    txId: "tx-1", fullHash: "hash-1", host, feePlanck: 1_000_000, broadcastAt: NOW,
  });

/** Answers per host, so a fallback can disagree with the pinned node. */
function pool(answers: Record<string, TransactionLookup | "throw">): MainnetPool {
  const asked: string[] = [];
  const p = {
    hosts: Object.keys(answers),
    asked,
    getTransaction: async (host: string) => {
      asked.push(host);
      const a = answers[host];
      if (a === undefined || a === "throw") throw new Error(`node ${host} unreachable`);
      return a;
    },
  } as unknown as MainnetPool & { asked: string[] };
  return p;
}

const deps = (p: MainnetPool, now = NOW) => ({
  db, pool: p, confirmationsRequired: 3, nowEpochSeconds: () => now,
});

describe("reconcileBatch", () => {
  test("no live batch is not an event", async () => {
    expect(await reconcileBatch(undefined, deps(pool({})))).toEqual({ kind: "none" });
  });

  test("a transaction in the mempool keeps the batch waiting", async () => {
    const { batchId } = claim();
    broadcast(batchId);

    const out = await reconcileBatch(getBatch(db, batchId), deps(pool({ "node-a": { kind: "mempool" } })));

    expect(out.kind).toBe("waiting");
    expect(getBatch(db, batchId)?.status).toBe("pending");
  });

  test("confirmations below the threshold move it to confirming, not confirmed", async () => {
    const { batchId } = claim();
    broadcast(batchId);
    // A transaction in the head block reads 0, so 0 is "in a block", not "unsent".
    const p = pool({ "node-a": { kind: "confirmed", confirmations: 0, height: 999 } });

    const out = await reconcileBatch(getBatch(db, batchId), deps(p));

    expect(out).toEqual({ kind: "confirming", batchId, confirmations: 0 });
    expect(getBatch(db, batchId)?.status).toBe("confirming");
  });

  test("reaching the required depth settles the batch", async () => {
    const { batchId } = claim();
    broadcast(batchId);
    const p = pool({ "node-a": { kind: "confirmed", confirmations: 3, height: 1_000 } });

    const out = await reconcileBatch(getBatch(db, batchId), deps(p));

    expect(out).toEqual({ kind: "settled", batchId, height: 1_000 });
    const row = getBatch(db, batchId)!;
    expect(row.status).toBe("confirmed");
    expect(row.confirmedHeight).toBe(1_000);
    expect(liveBatch(db)).toBeUndefined();
  });

  test("unknown on the pinned host is re-asked elsewhere before being believed", async () => {
    const { batchId } = claim();
    broadcast(batchId, "node-a");
    // node-a restarted and lost its in-memory mempool; node-b still holds it.
    const p = pool({ "node-a": { kind: "unknown" }, "node-b": { kind: "mempool" } });

    const out = await reconcileBatch(getBatch(db, batchId), deps(p));

    expect(out.kind).toBe("waiting");
    expect(getBatch(db, batchId)?.status).toBe("pending");
  });

  test("unknown everywhere INSIDE the deadline still does not release", async () => {
    // The decisive case. Releasing here would hand the accruals to the next
    // batch while the transaction is still able to confirm.
    const { batchId } = claim();
    broadcast(batchId);
    const p = pool({ "node-a": { kind: "unknown" }, "node-b": { kind: "unknown" } });

    const out = await reconcileBatch(getBatch(db, batchId), deps(p, DEADLINE - 1));

    expect(out.kind).toBe("waiting");
    expect(getBatch(db, batchId)?.status).toBe("pending");
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
  });

  test("unknown everywhere AFTER the deadline releases for the next cycle", async () => {
    const { batchId } = claim();
    broadcast(batchId);
    const p = pool({ "node-a": { kind: "unknown" }, "node-b": { kind: "unknown" } });

    const out = await reconcileBatch(getBatch(db, batchId), deps(p, DEADLINE + 1));

    expect(out.kind).toBe("released");
    expect(getBatch(db, batchId)?.status).toBe("failed");
    // Accruals are back in the pool for the next composition.
    expect(aggregateUnpaidByRecipient(db).map((a) => a.recipientId)).toEqual(["acct-1"]);
  });

  test("an unreachable fallback is not evidence the transaction is gone", async () => {
    const { batchId } = claim();
    broadcast(batchId);
    const p = pool({ "node-a": { kind: "unknown" }, "node-b": "throw" });

    const out = await reconcileBatch(getBatch(db, batchId), deps(p, DEADLINE - 1));

    expect(out.kind).toBe("waiting");
    expect(getBatch(db, batchId)?.status).toBe("pending");
  });

  test("a claimed batch with no transaction waits, then releases past the deadline", async () => {
    // The crash window: claimBatch committed, the send never recorded anything.
    const { batchId } = claim();
    const p = pool({ "node-a": { kind: "unknown" } });

    expect((await reconcileBatch(getBatch(db, batchId), deps(p, NOW))).kind).toBe("waiting");
    expect(getBatch(db, batchId)?.status).toBe("claimed");

    const out = await reconcileBatch(getBatch(db, batchId), deps(p, DEADLINE + 1));
    expect(out.kind).toBe("released");
    expect(aggregateUnpaidByRecipient(db).map((a) => a.recipientId)).toEqual(["acct-1"]);
  });

  test("a settled batch is never re-asked", async () => {
    const { batchId } = claim();
    broadcast(batchId);
    const p = pool({ "node-a": { kind: "confirmed", confirmations: 5, height: 7 } });
    await reconcileBatch(getBatch(db, batchId), deps(p));

    expect(await reconcileBatch(liveBatch(db), deps(p))).toEqual({ kind: "none" });
  });
});
