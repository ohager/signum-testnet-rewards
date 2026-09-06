import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { Crypto } from "@signumjs/crypto";
import { NodeJSCryptoAdapter } from "@signumjs/crypto/adapters";
import { generateSignKeys } from "@signumjs/crypto";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { getBatch, liveBatch, aggregateUnpaidByRecipient } from "../../src/ledger/batches.ts";
import { setPayoutsPaused, tripKillSwitch } from "../../src/ledger/state.ts";
import { createPayoutRunner } from "../../src/payout/runner.ts";
import type { RunOutcome } from "../../src/payout/runner.ts";
import type { MainnetPool } from "../../src/chain/mainnetPool.ts";

Crypto.init(new NodeJSCryptoAdapter());
const keys = generateSignKeys("a test seed that never touches a real account");

let db: Ledger;
let sent: unknown[];
let sendBehaviour: "ok" | "throw";
let balance: string;
let alerts: string[];
const NOW = 1_800_000_000;

beforeEach(() => {
  db = openLedger(":memory:");
  sent = [];
  sendBehaviour = "ok";
  balance = Amount.fromSigna("1000").getPlanck();
  alerts = [];
});

const accrue = (blockId: string, generatorId: string, signa: string) =>
  recordBlockReward(db, {
    blockId, height: Number(blockId.slice(1)), blockTimestamp: 500_000,
    chainDay: "2026-03-14", generatorId, generatorPublicKey: "pk",
    status: "accrued", amount: Amount.fromSigna(signa),
  });

function pool(): MainnetPool {
  const send = async (args: unknown) => {
    if (sendBehaviour === "throw") throw new Error("node rejected");
    sent.push(args);
    return {
      transaction: { transaction: "tx-99", fullHash: "hash-99" },
      host: "node-a",
    };
  };
  return {
    hosts: ["node-a", "node-b"],
    getAccount: async () => ({ account: "1", publicKey: keys.publicKey, balanceNQT: balance }),
    sendMultiOut: send,
    sendSingle: send,
    getTransaction: async () => ({ kind: "mempool" as const }),
    buildUnsignedMultiOut: async () => { throw new Error("unused"); },
    buildUnsignedSend: async () => { throw new Error("unused"); },
  } as unknown as MainnetPool;
}

const runner = (over: Partial<Parameters<typeof createPayoutRunner>[0]> = {}) =>
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
    nowEpochSeconds: () => NOW,
    onAlert: (kind, message) => alerts.push(`${kind}: ${message}`),
    ...over,
  });

/** Narrows to the blocked case so a wrong outcome fails loudly instead of undefined. */
const blockedReason = (out: RunOutcome): string => {
  expect(out.kind).toBe("blocked");
  return out.kind === "blocked" ? out.reason : "";
};

describe("payout runner gates", () => {
  test("refuses when payouts are disabled", async () => {
    accrue("b1", "acct-1", "10");
    accrue("b2", "acct-2", "10");
    const out = await runner({ payoutsEnabled: false }).release();

    expect(out).toEqual({ kind: "blocked", reason: "payouts are disabled by configuration" });
    expect(liveBatch(db)).toBeUndefined();
  });

  test("the kill switch outranks a pause", async () => {
    accrue("b1", "acct-1", "10");
    tripKillSwitch(db, "manual");
    setPayoutsPaused(db, true);

    expect(blockedReason(await runner().release())).toBe("the kill switch is tripped");
  });

  test("refuses while paused", async () => {
    accrue("b1", "acct-1", "10");
    setPayoutsPaused(db, true);

    expect(blockedReason(await runner().release())).toBe("payouts are paused");
  });

  test("refuses without a seed, so nothing can be signed", async () => {
    accrue("b1", "acct-1", "10");
    expect(blockedReason(await runner({ keys: undefined }).release())).toBe(
      "no payout account seed is configured",
    );
  });

  test("refuses when nothing clears the minimum payout", async () => {
    accrue("b1", "acct-1", "1");
    expect(blockedReason(await runner().release())).toBe("nothing is above the minimum payout");
    expect(liveBatch(db)).toBeUndefined();
  });

  test("refuses and alerts when the account cannot cover the batch plus fee", async () => {
    accrue("b1", "acct-1", "10");
    accrue("b2", "acct-2", "10");
    balance = Amount.fromSigna("20").getPlanck(); // 20 owed + 1 fee > 20 held

    const out = await runner().release();

    expect(out.kind).toBe("blocked");
    expect(blockedReason(out)).toContain("needs 21");
    expect(alerts[0]).toContain("payout_underfunded");
    // Nothing was stamped, so the accruals stay available.
    expect(aggregateUnpaidByRecipient(db)).toHaveLength(2);
  });

  test("a rails violation blocks before anything is claimed", async () => {
    accrue("b1", "acct-1", "500");
    const out = await runner().release();

    expect(out.kind).toBe("blocked");
    expect(blockedReason(out)).toContain("rail");
    expect(liveBatch(db)).toBeUndefined();
  });
});

describe("payout runner release", () => {
  test("claims, sends and records the transaction", async () => {
    accrue("b1", "acct-1", "10");
    accrue("b2", "acct-2", "20");

    const out = await runner().release();

    expect(out.kind).toBe("sent");
    const row = getBatch(db, (out as { batchId: number }).batchId)!;
    expect(row.status).toBe("pending");
    expect(row.txId).toBe("tx-99");
    expect(row.broadcastHost).toBe("node-a");
    // Accruals are stamped, so a second run cannot pay them again.
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
  });

  test("a single recipient takes the ordinary send path", async () => {
    accrue("b1", "acct-1", "10");
    await runner().release();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveProperty("recipientId", "acct-1");
  });

  test("two or more recipients take multi-out", async () => {
    accrue("b1", "acct-1", "10");
    accrue("b2", "acct-2", "10");
    await runner().release();

    expect(sent[0]).toHaveProperty("recipientAmounts");
  });

  test("a failed send leaves the batch claimed for the reconciler, and never retries", async () => {
    accrue("b1", "acct-1", "10");
    sendBehaviour = "throw";

    const out = await runner().release();

    expect(out.kind).toBe("send-failed");
    const row = liveBatch(db)!;
    // NOT released: the node may have accepted it and lost the response.
    expect(row.status).toBe("claimed");
    expect(row.attemptCount).toBe(1);
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
    expect(alerts.some((a) => a.startsWith("payout_send_unresolved"))).toBe(true);
  });

  test("refuses to start a second batch while one is in flight", async () => {
    accrue("b1", "acct-1", "10");
    const first = await runner().release();
    expect(first.kind).toBe("sent");

    accrue("b2", "acct-2", "10");
    const second = await runner().release();

    expect(second.kind).toBe("blocked");
    expect(blockedReason(second)).toContain("still in flight");
  });

  test("aborts when the batch changed since the operator approved it", async () => {
    accrue("b1", "acct-1", "10");
    const approved = runner().preview().draft.total.getPlanck();

    // A block lands between render and click.
    accrue("b2", "acct-2", "30");
    const out = await runner().release(approved);

    expect(out.kind).toBe("blocked");
    expect(blockedReason(out)).toContain("changed since it was shown");
    expect(liveBatch(db)).toBeUndefined();
  });

  test("proceeds when the approved total still matches", async () => {
    accrue("b1", "acct-1", "10");
    const r = runner();
    const approved = r.preview().draft.total.getPlanck();

    expect((await r.release(approved)).kind).toBe("sent");
  });
});

describe("payout runner tick", () => {
  test("never sends", async () => {
    accrue("b1", "acct-1", "10");
    const out = await runner().tick();

    expect(out).toEqual({ kind: "none" });
    expect(sent).toEqual([]);
    expect(liveBatch(db)).toBeUndefined();
  });

  test("advances a live batch it finds", async () => {
    accrue("b1", "acct-1", "10");
    const r = runner();
    await r.release();

    expect((await r.tick()).kind).toBe("waiting");
  });
});
