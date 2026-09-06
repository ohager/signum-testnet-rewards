import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { claimBatch, markBroadcast, markConfirmed, releaseBatch } from "../../src/ledger/batches.ts";
import { assessReset, wipeRemote, removeLocalFiles } from "../../src/ops/reset.ts";

let db: Ledger;
let dir: string;

beforeEach(() => {
  db = openLedger(":memory:");
  dir = mkdtempSync(join(tmpdir(), "reset-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const claim = (blockId: string, acct: string) => {
  recordBlockReward(db, {
    blockId, height: 1, blockTimestamp: 500_000, chainDay: "2026-03-14",
    generatorId: acct, generatorPublicKey: "pk", status: "accrued",
    amount: Amount.fromSigna("10"),
  });
  return claimBatch(db, { recipientIds: [acct], deadlineAt: 1_800_001_800 });
};

describe("assessReset", () => {
  test("a ledger that never paid anyone is safe", () => {
    recordBlockReward(db, {
      blockId: "b1", height: 1, blockTimestamp: 500_000, chainDay: "2026-03-14",
      generatorId: "acct-1", generatorPublicKey: "pk", status: "accrued",
      amount: Amount.fromSigna("10"),
    });
    expect(assessReset(db)).toEqual({ safe: true });
  });

  test("a confirmed batch blocks the reset", () => {
    const { batchId } = claim("b1", "acct-1");
    markBroadcast(db, batchId, {
      txId: "tx-1", fullHash: "h", host: "node-a", feePlanck: 1, broadcastAt: 1,
    });
    markConfirmed(db, batchId, { confirmedAt: 2, height: 3 });

    const out = assessReset(db);
    expect(out.safe).toBe(false);
    if (out.safe) throw new Error("unreachable");
    expect(out.batches).toHaveLength(1);
    expect(out.batches[0]?.txId).toBe("tx-1");
    expect(out.reason).toContain("1 confirmed");
  });

  test("a batch still in the mempool blocks the reset", () => {
    const { batchId } = claim("b1", "acct-1");
    markBroadcast(db, batchId, {
      txId: "tx-2", fullHash: "h", host: "node-a", feePlanck: 1, broadcastAt: 1,
    });
    expect(assessReset(db).safe).toBe(false);
  });

  test("a claimed batch with no transaction blocks the reset", () => {
    // The ambiguous state: the send may have landed and lost its response.
    claim("b1", "acct-1");
    const out = assessReset(db);

    expect(out.safe).toBe(false);
    if (out.safe) throw new Error("unreachable");
    expect(out.reason).toContain("1 still live or unresolved");
  });

  test("a failed batch does NOT block: expiry is consensus-enforced", () => {
    // Released only after its deadline passed, so its transaction can never be
    // included. Nothing was paid, so nothing can be paid twice.
    const { batchId } = claim("b1", "acct-1");
    releaseBatch(db, batchId, "deadline expired");

    expect(assessReset(db)).toEqual({ safe: true });
  });

  test("one live batch among failed ones is still enough to block", () => {
    const first = claim("b1", "acct-1");
    releaseBatch(db, first.batchId, "deadline expired");
    claim("b2", "acct-2");

    expect(assessReset(db).safe).toBe(false);
  });
});

describe("wipeRemote", () => {
  test("empties every table in the published schema, not a hand-written list", async () => {
    const issued: string[][] = [];
    const tables = await wipeRemote({
      batch: async (statements) => {
        issued.push(statements);
      },
    });

    expect(tables.sort()).toEqual(["miners", "payouts", "status"]);
    expect(issued[0]?.sort()).toEqual([
      "DELETE FROM miners", "DELETE FROM payouts", "DELETE FROM status",
    ]);
  });

  test("propagates a failure so the caller can abort before touching local state", async () => {
    await expect(
      wipeRemote({ batch: async () => { throw new Error("turso unreachable"); } }),
    ).rejects.toThrow("turso unreachable");
  });
});

describe("removeLocalFiles", () => {
  test("removes the ledger, its sidecars and the walker cache together", () => {
    const paths = {
      databasePath: join(dir, "rewards.sqlite"),
      walkerCachePath: join(dir, "chainwalker.cache.json"),
    };
    for (const f of [
      paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`,
      paths.walkerCachePath,
    ]) {
      writeFileSync(f, "x");
    }

    const removed = removeLocalFiles(paths);

    expect(removed).toHaveLength(4);
    // Both must go: a surviving walker cache would resume at the current height
    // against an empty ledger and silently skip everything before it.
    expect(existsSync(paths.databasePath)).toBe(false);
    expect(existsSync(paths.walkerCachePath)).toBe(false);
  });

  test("missing files are not an error", () => {
    const paths = {
      databasePath: join(dir, "absent.sqlite"),
      walkerCachePath: join(dir, "absent.json"),
    };
    expect(removeLocalFiles(paths)).toEqual([]);
  });
});
