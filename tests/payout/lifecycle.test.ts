import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { Crypto, generateSignKeys } from "@signumjs/crypto";
import { NodeJSCryptoAdapter } from "@signumjs/crypto/adapters";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { getBatch, liveBatch, aggregateUnpaidByRecipient } from "../../src/ledger/batches.ts";
import { createPayoutRunner } from "../../src/payout/runner.ts";
import type { MainnetPool, TransactionLookup } from "../../src/chain/mainnetPool.ts";

Crypto.init(new NodeJSCryptoAdapter());
const keys = generateSignKeys("integration seed, not a real account");

let db: Ledger;
let lookup: TransactionLookup;
let clock: number;
let sendThrows: boolean;
const START = 1_800_000_000;

beforeEach(() => {
  db = openLedger(":memory:");
  lookup = { kind: "mempool" };
  clock = START;
  sendThrows = false;
  for (const [i, acct] of ["acct-1", "acct-2"].entries()) {
    recordBlockReward(db, {
      blockId: `b${i}`, height: i + 1, blockTimestamp: 500_000, chainDay: "2026-03-14",
      generatorId: acct, generatorPublicKey: "pk", status: "accrued",
      amount: Amount.fromSigna("25"),
    });
  }
});

const pool = () =>
  ({
    hosts: ["node-a", "node-b"],
    getAccount: async () => ({
      account: "1", publicKey: keys.publicKey, balanceNQT: Amount.fromSigna("500").getPlanck(),
    }),
    sendMultiOut: async () => {
      if (sendThrows) throw new Error("connection reset");
      return { transaction: { transaction: "tx-int", fullHash: "hash-int" }, host: "node-a" };
    },
    sendSingle: async () => ({
      transaction: { transaction: "tx-int", fullHash: "hash-int" }, host: "node-a",
    }),
    getTransaction: async () => lookup,
  }) as unknown as MainnetPool;

const runner = () =>
  createPayoutRunner({
    db,
    pool: pool(),
    minPayout: Amount.fromSigna("5"),
    rails: {
      maxPerRecipientPerBatch: Amount.fromSigna("200"),
      maxPerBatch: Amount.fromSigna("2000"),
      maxPerWallClockDay: Amount.fromSigna("3000"),
    },
    fee: Amount.fromSigna("1"),
    deadlineMinutes: 30,
    confirmationsRequired: 3,
    payoutsEnabled: true,
    keys: { publicKey: keys.publicKey, signPrivateKey: keys.signPrivateKey },
    nowEpochSeconds: () => clock,
  });

describe("payout lifecycle across ticks", () => {
  test("claimed → pending → confirming → confirmed", async () => {
    const r = runner();

    const sent = await r.release();
    expect(sent.kind).toBe("sent");
    expect(getBatch(db, 1)?.status).toBe("pending");

    // Still in the mempool: nothing changes, and the batch stays live.
    lookup = { kind: "mempool" };
    clock += 240;
    expect((await r.tick()).kind).toBe("waiting");
    expect(getBatch(db, 1)?.status).toBe("pending");

    // Included in the head block. 0 confirmations means "in a block", not "unsent".
    lookup = { kind: "confirmed", confirmations: 0, height: 1_200_000 };
    clock += 240;
    expect((await r.tick()).kind).toBe("confirming");
    expect(getBatch(db, 1)?.status).toBe("confirming");

    lookup = { kind: "confirmed", confirmations: 3, height: 1_200_000 };
    clock += 720;
    expect((await r.tick()).kind).toBe("settled");

    const row = getBatch(db, 1)!;
    expect(row.status).toBe("confirmed");
    expect(row.confirmedHeight).toBe(1_200_000);
    expect(liveBatch(db)).toBeUndefined();
    // Paid: nothing is owed any more.
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
  });

  test("a dropped transaction is released only after the deadline, then re-composed", async () => {
    const r = runner();
    await r.release();

    // Vanishes everywhere, but the deadline has not passed.
    lookup = { kind: "unknown" };
    clock += 600;
    expect((await r.tick()).kind).toBe("waiting");
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
    // A new batch must not start on top of a transaction that may still confirm.
    expect((await r.release()).kind).toBe("blocked");

    clock = START + 1_801;
    expect((await r.tick()).kind).toBe("released");
    expect(getBatch(db, 1)?.status).toBe("failed");

    // The same money is available again, and the next cycle sends it.
    expect(aggregateUnpaidByRecipient(db)).toHaveLength(2);
    lookup = { kind: "mempool" };
    const retry = await r.release();
    expect(retry.kind).toBe("sent");
    expect((retry as { batchId: number }).batchId).toBe(2);
  });

  test("a send whose outcome is unknown is adopted if the transaction turns up", async () => {
    // The crash window: the node accepted it but the response was lost, so the
    // batch is stamped with no transaction id recorded.
    sendThrows = true;
    const r = runner();
    expect((await r.release()).kind).toBe("send-failed");
    expect(liveBatch(db)?.status).toBe("claimed");

    // Within the deadline nothing is released, so the accruals cannot be paid twice.
    clock += 600;
    expect((await r.tick()).kind).toBe("waiting");
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
  });
});
