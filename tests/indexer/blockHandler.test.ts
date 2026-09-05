import { test, expect, describe, beforeEach } from "bun:test";
import type { Block } from "@signumjs/core";
import { Amount, ChainTime } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { getBlockReward, sumAccruedGlobalOnDay } from "../../src/ledger/blockRewards.ts";
import { createBlockHandler } from "../../src/indexer/blockHandler.ts";
import type { RewardPolicyConfig } from "../../src/domain/policy.ts";
import type { MainnetAccountFacts } from "../../src/eligibility/eligibility.ts";

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

/** Deliberately tiny caps so the cap paths are reachable in a few blocks. */
const policy: RewardPolicyConfig = {
  rewardPerBlock: Amount.fromSigna("2.5"),
  accountDailyCap: Amount.fromSigna("5"),
  globalDailyBudget: Amount.fromSigna("7.5"),
};

const DAY = "2026-03-14";
const tsFor = (isoDate: string): number =>
  ChainTime.fromDate(new Date(`${isoDate}T12:00:00Z`)).getChainTimestamp();

const makeBlock = (over: Partial<Block>): Block =>
  ({
    block: "block-1",
    height: 1000,
    timestamp: tsFor(DAY),
    generator: "acct-1",
    generatorRS: "TS-XXXX-XXXX-XXXX-XXXXX",
    generatorPublicKey: "pk-acct-1",
    ...over,
  }) as unknown as Block;

const activeAccount: MainnetAccountFacts = { isActive: true, publicKey: "pk-acct-1" };

const handlerWith = (opts: {
  lookup?: (id: string) => Promise<MainnetAccountFacts | undefined>;
  isExcluded?: (id: string) => boolean;
}) =>
  createBlockHandler({
    db, policy,
    lookupMainnetAccount: opts.lookup ?? (async () => activeAccount),
    isExcluded: opts.isExcluded ?? (() => false),
  });

describe("block handler", () => {
  test("accrues a reward for an eligible generator", async () => {
    await handlerWith({})(makeBlock({}));
    const row = getBlockReward(db, "block-1");
    expect(row?.status).toBe("accrued");
    expect(row?.amount.getSigna()).toBe("2.5");
    expect(row?.chainDay).toBe(DAY);
  });

  test("records a skip when the generator has no mainnet account", async () => {
    await handlerWith({ lookup: async () => undefined })(makeBlock({}));
    const row = getBlockReward(db, "block-1");
    expect(row?.status).toBe("skipped_no_mainnet_account");
    expect(row?.amount.getPlanck()).toBe("0");
  });

  test("records a skip for an excluded account", async () => {
    await handlerWith({ isExcluded: () => true })(makeBlock({}));
    expect(getBlockReward(db, "block-1")?.status).toBe("skipped_excluded");
  });

  test("records a skip when public keys disagree", async () => {
    await handlerWith({ lookup: async () => ({ isActive: true, publicKey: "some-other-key" }) })(
      makeBlock({}),
    );
    expect(getBlockReward(db, "block-1")?.status).toBe("skipped_pubkey_mismatch");
  });

  test("enforces the per-account daily cap across blocks", async () => {
    const handler = handlerWith({});
    await handler(makeBlock({ block: "b1", height: 1 }));
    await handler(makeBlock({ block: "b2", height: 2 }));
    await handler(makeBlock({ block: "b3", height: 3 }));
    expect(getBlockReward(db, "b3")?.status).toBe("skipped_account_cap");
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("5");
  });

  test("enforces the global daily budget across accounts", async () => {
    const handler = handlerWith({
      lookup: async (id) => ({ isActive: true, publicKey: `pk-${id}` }),
    });
    await handler(makeBlock({ block: "b1", height: 1, generator: "a", generatorPublicKey: "pk-a" }));
    await handler(makeBlock({ block: "b2", height: 2, generator: "a", generatorPublicKey: "pk-a" }));
    await handler(makeBlock({ block: "b3", height: 3, generator: "b", generatorPublicKey: "pk-b" }));
    await handler(makeBlock({ block: "b4", height: 4, generator: "c", generatorPublicKey: "pk-c" }));
    expect(getBlockReward(db, "b4")?.status).toBe("skipped_global_cap");
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("7.5");
  });

  test("CHAIN-DAY: caps reset on the next chain day, not the next wall-clock day", async () => {
    const handler = handlerWith({});
    await handler(makeBlock({ block: "b1", height: 1, timestamp: tsFor("2026-03-14") }));
    await handler(makeBlock({ block: "b2", height: 2, timestamp: tsFor("2026-03-14") }));
    await handler(makeBlock({ block: "b3", height: 3, timestamp: tsFor("2026-03-14") }));
    expect(getBlockReward(db, "b3")?.status).toBe("skipped_account_cap");
    await handler(makeBlock({ block: "b4", height: 4, timestamp: tsFor("2026-03-15") }));
    expect(getBlockReward(db, "b4")?.status).toBe("accrued");
  });

  test("REPLAY: handling the same block twice does not double-accrue", async () => {
    const handler = handlerWith({});
    await handler(makeBlock({}));
    await handler(makeBlock({}));
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("2.5");
  });

  test("REPLAY: a replayed block does not re-query the mainnet account", async () => {
    let lookups = 0;
    const handler = handlerWith({
      lookup: async () => { lookups++; return activeAccount; },
    });
    await handler(makeBlock({}));
    await handler(makeBlock({}));
    expect(lookups).toBe(1);
  });

  test("MUTATION SAFETY: the policy config is unchanged after many blocks", async () => {
    const handler = handlerWith({});
    for (let i = 0; i < 5; i++) await handler(makeBlock({ block: `m${i}`, height: i }));
    expect(policy.rewardPerBlock.getSigna()).toBe("2.5");
    expect(policy.accountDailyCap.getSigna()).toBe("5");
  });
});
