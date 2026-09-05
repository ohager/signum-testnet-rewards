import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block, UnconfirmedTransactionList } from "@signumjs/core";
import type { MockLedger } from "signum-chain-walker/dist/mockLedger";
import { ChainWalker } from "signum-chain-walker";
import { Amount, ChainTime } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { createBlockHandler } from "../../src/indexer/blockHandler.ts";

let db: Ledger;
let dir: string;

beforeEach(() => {
  db = openLedger(":memory:");
  dir = mkdtempSync(join(tmpdir(), "walker-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TIP = 1005;
const START = 1000;

const blockAt = (height: number): Block =>
  ({
    block: `block-${height}`,
    height,
    timestamp: ChainTime.fromDate(new Date("2026-03-14T12:00:00Z")).getChainTimestamp(),
    generator: "acct-1",
    generatorRS: "TS-XXXX",
    generatorPublicKey: "pk-acct-1",
    transactions: [],
  }) as unknown as Block;

const mockLedger: MockLedger = {
  block: {
    // height === undefined means "the current block", per fetchCurrentBlockHeight
    getBlockByHeight: async (height: number, _includeTransactions: boolean) =>
      blockAt(height === undefined ? TIP : height),
  },
  transaction: {
    getUnconfirmedTransactions: async () =>
      ({ unconfirmedTransactions: [] }) as unknown as UnconfirmedTransactionList,
  },
};

const walkOnce = async (cachePath: string) => {
  const handler = createBlockHandler({
    db,
    policy: {
      rewardPerBlock: Amount.fromSigna("2.5"),
      accountDailyCap: Amount.fromSigna("100"),
      globalDailyBudget: Amount.fromSigna("1000"),
    },
    lookupMainnetAccount: async () => ({ isActive: true, publicKey: "pk-acct-1" }),
    isExcluded: () => false,
  });

  const walker = new ChainWalker({
    nodeHost: "http://unused",
    mockLedger,
    cachePath,
    blockOffset: 0,
  }).onBlock(async (block) => {
    await handler(block);
  });

  await walker.walk(START);
};

describe("ChainWalker integration", () => {
  test("walking records the blocks it processes", async () => {
    await walkOnce(join(dir, "cache.json"));
    const rows = db.query("SELECT COUNT(*) AS c FROM block_rewards").get() as { c: number };
    expect(rows.c).toBeGreaterThan(0);
    const tip = db
      .query("SELECT COUNT(*) AS c FROM block_rewards WHERE block_id = ?1")
      .get(`block-${TIP}`) as { c: number };
    expect(tip.c).toBe(1);
  });

  test("RESTART SAFETY: walking again from scratch adds nothing", async () => {
    // A fresh cache file forces a full re-walk, simulating the worst case where
    // the walker cache is lost but the ledger survives.
    await walkOnce(join(dir, "cache-a.json"));
    const first = db.query("SELECT COUNT(*) AS c FROM block_rewards").get() as { c: number };
    await walkOnce(join(dir, "cache-b.json"));
    const second = db.query("SELECT COUNT(*) AS c FROM block_rewards").get() as { c: number };
    expect(second.c).toBe(first.c);
  });
}, 20_000);
