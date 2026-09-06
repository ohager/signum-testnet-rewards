import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import {
  recordBlockReward,
  sumAccruedForAccountOnDay,
  sumAccruedGlobalOnDay,
  getBlockReward,
  countByStatus,
  getLastProcessedHeight,
} from "../../src/ledger/blockRewards.ts";
import type { BlockRewardInput } from "../../src/ledger/blockRewards.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

const input = (over: Partial<BlockRewardInput> = {}): BlockRewardInput => ({
  blockId: "block-1",
  height: 1000,
  blockTimestamp: 500_000,
  chainDay: "2026-03-14",
  generatorId: "acct-1",
  generatorPublicKey: "pubkey-1",
  status: "accrued",
  amount: Amount.fromSigna("2.5"),
  ...over,
});

describe("recordBlockReward", () => {
  test("inserts a new block and reports that it did", () => {
    expect(recordBlockReward(db, input())).toBe(true);
    expect(getBlockReward(db, "block-1")?.amount.getSigna()).toBe("2.5");
  });

  test("REPLAY SAFETY: recording the same block twice yields exactly one row", () => {
    expect(recordBlockReward(db, input())).toBe(true);
    expect(recordBlockReward(db, input())).toBe(false);
    const rows = db.query("SELECT COUNT(*) AS c FROM block_rewards").get() as { c: number };
    expect(rows.c).toBe(1);
  });

  test("REPLAY SAFETY: a replay cannot inflate the daily total", () => {
    recordBlockReward(db, input());
    recordBlockReward(db, input());
    recordBlockReward(db, input());
    expect(sumAccruedForAccountOnDay(db, "acct-1", "2026-03-14").getSigna()).toBe("2.5");
  });

  test("a different block at the same height is stored separately, not merged", () => {
    recordBlockReward(db, input({ blockId: "block-1" }));
    recordBlockReward(db, input({ blockId: "block-1-fork" }));
    const rows = db
      .query("SELECT COUNT(*) AS c FROM block_rewards WHERE height = 1000")
      .get() as { c: number };
    expect(rows.c).toBe(2);
  });

  test("stores whole planck, so decimal SIGNA survives the round trip exactly", () => {
    recordBlockReward(db, input({ amount: Amount.fromSigna("0.00000001") }));
    expect(getBlockReward(db, "block-1")?.amount.getPlanck()).toBe("1");
  });
});

describe("daily sums", () => {
  test("counts only accrued rows, never skipped ones", () => {
    recordBlockReward(db, input({ blockId: "b1" }));
    recordBlockReward(
      db,
      input({ blockId: "b2", status: "skipped_account_cap", amount: Amount.Zero() }),
    );
    recordBlockReward(
      db,
      input({ blockId: "b3", status: "skipped_no_mainnet_account", amount: Amount.Zero() }),
    );
    expect(sumAccruedForAccountOnDay(db, "acct-1", "2026-03-14").getSigna()).toBe("2.5");
  });

  test("separates accounts", () => {
    recordBlockReward(db, input({ blockId: "b1", generatorId: "acct-1" }));
    recordBlockReward(db, input({ blockId: "b2", generatorId: "acct-2" }));
    expect(sumAccruedForAccountOnDay(db, "acct-1", "2026-03-14").getSigna()).toBe("2.5");
    expect(sumAccruedGlobalOnDay(db, "2026-03-14").getSigna()).toBe("5");
  });

  test("separates chain days", () => {
    recordBlockReward(db, input({ blockId: "b1", chainDay: "2026-03-14" }));
    recordBlockReward(db, input({ blockId: "b2", chainDay: "2026-03-15" }));
    expect(sumAccruedGlobalOnDay(db, "2026-03-14").getSigna()).toBe("2.5");
    expect(sumAccruedGlobalOnDay(db, "2026-03-15").getSigna()).toBe("2.5");
  });

  test("returns zero rather than null for an empty day", () => {
    expect(sumAccruedGlobalOnDay(db, "2099-01-01").getPlanck()).toBe("0");
    expect(sumAccruedForAccountOnDay(db, "nobody", "2099-01-01").getPlanck()).toBe("0");
  });

  test("MUTATION SAFETY: each call returns an independent Amount", () => {
    recordBlockReward(db, input());
    const first = sumAccruedGlobalOnDay(db, "2026-03-14");
    first.add(Amount.fromSigna("1000"));
    expect(sumAccruedGlobalOnDay(db, "2026-03-14").getSigna()).toBe("2.5");
  });
});

describe("countByStatus and getLastProcessedHeight", () => {
  test("groups blocks by outcome for the status page", () => {
    recordBlockReward(db, input({ blockId: "b1" }));
    recordBlockReward(db, input({ blockId: "b2" }));
    recordBlockReward(
      db,
      input({ blockId: "b3", status: "skipped_no_mainnet_account", amount: Amount.Zero() }),
    );
    const counts = countByStatus(db);
    expect(counts.accrued).toBe(2);
    expect(counts.skipped_no_mainnet_account).toBe(1);
  });

  test("reports the highest observed height, or undefined when empty", () => {
    expect(getLastProcessedHeight(db)).toBeUndefined();
    recordBlockReward(db, input({ blockId: "b1", height: 10 }));
    recordBlockReward(db, input({ blockId: "b2", height: 42 }));
    expect(getLastProcessedHeight(db)).toBe(42);
  });
});
