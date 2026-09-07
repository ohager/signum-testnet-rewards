import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import {
  recordBlockReward,
  getBlockReward,
  sumAccruedGlobalOnDay,
  activeBlockRewardsAtHeight,
  lastIndexedBlock,
} from "../../src/ledger/blockRewards.ts";
import { createReorgAuditor } from "../../src/indexer/reorgAudit.ts";
import { listOpenAlerts, listUnnotifiedAlerts } from "../../src/ledger/alerts.ts";
import {
  isKillSwitchTripped,
  getReorgAuditHeight,
  setReorgAuditHeight,
  getChainHalt,
} from "../../src/ledger/state.ts";
import { claimBatch } from "../../src/ledger/batches.ts";

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

const DAY = "2026-03-14";

const record = (over: { blockId: string; height: number; generatorId?: string; status?: "accrued" }) =>
  recordBlockReward(db, {
    blockId: over.blockId,
    height: over.height,
    blockTimestamp: 1000,
    chainDay: DAY,
    generatorId: over.generatorId ?? "acct-1",
    generatorPublicKey: "pk-acct-1",
    status: over.status ?? "accrued",
    amount: Amount.fromSigna("2.5"),
  });

/**
 * An auditor over a fake chain. `chain` maps height to the block id the node
 * currently reports, and `reindex` records it the way the real handler would.
 */
const auditorOver = (
  chain: Record<number, string>,
  opts: {
    depth?: number;
    maxBacklog?: number;
    head?: number;
    scrubWindow?: number;
    scrubBatch?: number;
    now?: () => number;
    rollbackNoticeWindowMs?: number;
  } = {},
) => {
  const reindexed: number[] = [];
  const resumedFrom: number[] = [];
  const auditor = createReorgAuditor({
    db,
    depth: opts.depth ?? 10,
    maxBacklog: opts.maxBacklog,
    scrubWindow: opts.scrubWindow,
    scrubBatch: opts.scrubBatch,
    now: opts.now,
    rollbackNoticeWindowMs: opts.rollbackNoticeWindowMs,
    nodeHeadHeight: async () => {
      if (opts.head === undefined) throw new Error("node unreachable");
      return opts.head;
    },
    resumeIndexingFrom: async (height) => { resumedFrom.push(height); },
    // The walker's own position, which the tests move only through the ledger.
    indexerPosition: async () => undefined,
    canonicalBlockIdAt: async (height) => {
      const id = chain[height];
      if (id === undefined) throw new Error(`node has no block at ${height}`);
      return id;
    },
    reindex: async (height) => {
      reindexed.push(height);
      record({ blockId: chain[height]!, height });
    },
  });
  return { auditor, reindexed, resumedFrom };
};

describe("reorg audit", () => {
  test("a height whose block still matches is left alone", async () => {
    record({ blockId: "block-a", height: 100 });
    const { auditor, reindexed } = auditorOver({ 100: "block-a" });

    expect(await auditor.auditHeight(100)).toEqual({ kind: "intact", height: 100 });
    expect(reindexed).toEqual([]);
    expect(getBlockReward(db, "block-a")?.status).toBe("accrued");
  });

  test("REORG: the replaced block is rolled back and the winner is scored", async () => {
    record({ blockId: "loser", height: 100 });
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("2.5");

    const { auditor, reindexed } = auditorOver({ 100: "winner" });
    const outcome = await auditor.auditHeight(100);

    expect(outcome.kind).toBe("reorged");
    expect(getBlockReward(db, "loser")?.status).toBe("orphaned");
    expect(reindexed).toEqual([100]);
    expect(getBlockReward(db, "winner")?.status).toBe("accrued");
    // The budget is not double-counted: the loser gave its room back.
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("2.5");
  });

  test("an orphaned row keeps its amount, so the loss stays explainable", async () => {
    record({ blockId: "loser", height: 100 });
    const { auditor } = auditorOver({ 100: "winner" });
    await auditor.auditHeight(100);

    const row = getBlockReward(db, "loser");
    expect(row?.amount.getSigna()).toBe("2.5");
    expect(row?.orphanedAt ?? null).not.toBeNull();
  });

  test("A ROLLED-BACK ACCRUAL IS A NOTICE, NOT AN OPEN INCIDENT", async () => {
    record({ blockId: "loser", height: 100 });
    const { auditor } = auditorOver({ 100: "winner" });
    await auditor.catchUpTo(110);
    auditor.flushNotices();

    expect(listOpenAlerts(db)).toHaveLength(0);
    expect(listUnnotifiedAlerts(db).map((a) => a.kind)).toEqual(["reorg_rolled_back"]);
    expect(isKillSwitchTripped(db)).toBe(false);
  });

  test("ONE REORG IS ONE NOTIFICATION, however many blocks it replaced", async () => {
    // Repairing the real incident this was built for rolled back sixty-five
    // heights. One notification per height is the fan-out that started all of
    // this, just wearing a different hat.
    const chain: Record<number, string> = {};
    for (let height = 100; height < 165; height++) {
      record({ blockId: `loser-${height}`, height });
      chain[height] = `winner-${height}`;
    }
    setReorgAuditHeight(db, 99);
    const { auditor } = auditorOver(chain);
    await auditor.catchUpTo(174);
    auditor.flushNotices();

    const notices = listUnnotifiedAlerts(db);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain("65 block(s) between heights 100 and 164");
  });

  test("the summary is held only for its window, not indefinitely", async () => {
    let clock = 1_000_000;
    // A short window so the test does not have to reason about real minutes.
    const { auditor } = auditorOver({ 100: "winner" }, { now: () => clock, rollbackNoticeWindowMs: 60_000 });
    record({ blockId: "loser", height: 100 });

    await auditor.catchUpTo(110);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);

    clock += 60_001;
    await auditor.scrub(); // the next ordinary patrol
    expect(listUnnotifiedAlerts(db).map((a) => a.kind)).toEqual(["reorg_rolled_back"]);
  });

  test("MONEY ALREADY GONE: a paid orphan halts payouts and opens an incident", async () => {
    record({ blockId: "loser", height: 100 });
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 0 });

    const { auditor } = auditorOver({ 100: "winner" });
    await auditor.catchUpTo(110);

    expect(listOpenAlerts(db).map((a) => a.kind)).toEqual(["reorg_paid_accrual"]);
    expect(isKillSwitchTripped(db)).toBe(true);
  });

  test("A DIRECT auditHeight STILL HALTS ON A PAID ORPHAN: the repair tool's path", async () => {
    // The one-off repair tool loops auditHeight directly. When reporting lived
    // in the callers instead, that path rolled accruals back in silence — no
    // incident, no halt, whatever it found.
    record({ blockId: "loser", height: 100 });
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 0 });
    const { auditor } = auditorOver({ 100: "winner" });

    await auditor.auditHeight(100);

    expect(listOpenAlerts(db).map((a) => a.kind)).toEqual(["reorg_paid_accrual"]);
    expect(isKillSwitchTripped(db)).toBe(true);
  });

  test("a direct auditHeight still gathers a rollback notice", async () => {
    record({ blockId: "loser", height: 100 });
    const { auditor } = auditorOver({ 100: "winner" });

    await auditor.auditHeight(100);
    auditor.flushNotices();

    expect(listUnnotifiedAlerts(db).map((a) => a.kind)).toEqual(["reorg_rolled_back"]);
  });

  test("SILENCE IS NOT EVIDENCE: an unreachable node rolls nothing back", async () => {
    record({ blockId: "block-a", height: 100 });
    const { auditor } = auditorOver({}); // every lookup throws

    const outcome = await auditor.auditHeight(100);
    expect(outcome.kind).toBe("unchecked");
    expect(getBlockReward(db, "block-a")?.status).toBe("accrued");
  });

  test("the watermark stops at the height that could not be checked", async () => {
    record({ blockId: "block-100", height: 100 });
    record({ blockId: "block-101", height: 101 });
    record({ blockId: "block-102", height: 102 });
    setReorgAuditHeight(db, 99);

    // The node answers for 100 and 102, but not for 101.
    const { auditor } = auditorOver({ 100: "block-100", 102: "block-102" });
    await auditor.catchUpTo(112);

    expect(getReorgAuditHeight(db)).toBe(100);
  });

  test("a height nothing was indexed at counts as verified", async () => {
    const { auditor } = auditorOver({});
    expect(await auditor.auditHeight(100)).toEqual({ kind: "intact", height: 100 });
  });

  test("verification trails the tip by the configured depth", async () => {
    record({ blockId: "loser", height: 100 });
    const { auditor, reindexed } = auditorOver({ 100: "winner" }, { depth: 10 });

    // The tip is only 9 blocks past it: too fresh to act on.
    await auditor.catchUpTo(109);
    expect(reindexed).toEqual([]);
    expect(getBlockReward(db, "loser")?.status).toBe("accrued");

    await auditor.catchUpTo(110);
    expect(reindexed).toEqual([100]);
  });

  test("a backlog is capped rather than replayed in full", async () => {
    setReorgAuditHeight(db, 0);
    const { auditor } = auditorOver({}, { maxBacklog: 5 });
    await auditor.catchUpTo(1010);
    // Verified the newest five settled heights, not the previous thousand.
    expect(getReorgAuditHeight(db)).toBe(1000);
  });

  test("REORG BACK: a block that wins again is restored, not left orphaned", async () => {
    record({ blockId: "original", height: 100 });
    const chain: Record<number, string> = { 100: "challenger" };
    const { auditor } = auditorOver(chain);

    await auditor.auditHeight(100);
    expect(getBlockReward(db, "original")?.status).toBe("orphaned");

    // The chain changes its mind back.
    chain[100] = "original";
    setReorgAuditHeight(db, 99);
    await auditor.auditHeight(100);

    expect(getBlockReward(db, "original")?.status).toBe("accrued");
    expect(getBlockReward(db, "challenger")?.status).toBe("orphaned");
    expect(activeBlockRewardsAtHeight(db, 100).map((r) => r.blockId)).toEqual(["original"]);
    // One block at that height earns once, however many times the chain flipped.
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("2.5");
  });

  test("the head the service reports is a live block, never an orphaned one", async () => {
    record({ blockId: "loser", height: 100 });
    const { auditor } = auditorOver({ 100: "winner" });
    await auditor.auditHeight(100);

    expect(lastIndexedBlock(db)?.blockId).toBe("winner");
  });
});

describe("chain rewind", () => {
  /** A hundred indexed blocks, 1000..1099, all still live. */
  const indexHeights = (from: number, to: number) => {
    for (let height = from; height <= to; height++) {
      record({ blockId: `block-${height}`, height });
    }
  };

  test("a head that has not moved backwards is not a rewind", async () => {
    indexHeights(1000, 1009);
    const { auditor, resumedFrom } = auditorOver({}, { head: 1011 });

    expect(await auditor.checkForRewind()).toEqual({ kind: "none" });
    expect(resumedFrom).toEqual([]);
  });

  test("A HUNDRED-BLOCK POP: every accrual above the new head is rolled back", async () => {
    // The walker only ever asks for lastProcessed + 1, so on its own it would
    // sit waiting for block 1100 while the chain rebuilt from 1000 — hours of
    // indexing nothing, and a hundred accruals for blocks that no longer exist.
    indexHeights(1000, 1099);
    const { auditor } = auditorOver({}, { head: 999, depth: 10 });

    const outcome = await auditor.checkForRewind();

    expect(outcome.kind).toBe("rewound");
    expect(outcome.kind === "rewound" && outcome.orphaned).toHaveLength(100);
    expect(activeBlockRewardsAtHeight(db, 1050)).toEqual([]);
    // Nothing was paid, so the whole hundred blocks' worth is given back.
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("0");
  });

  test("indexing resumes at the new head instead of waiting for a block that will never come", async () => {
    indexHeights(1000, 1099);
    const { auditor, resumedFrom } = auditorOver({}, { head: 999 });

    await auditor.checkForRewind();
    expect(resumedFrom).toEqual([999]);
  });

  test("the audit is sent back below the new head, where the branch may also differ", async () => {
    indexHeights(1000, 1099);
    setReorgAuditHeight(db, 1089);
    const { auditor } = auditorOver({}, { head: 999, depth: 10 });

    await auditor.checkForRewind();
    expect(getReorgAuditHeight(db)).toBe(989);
  });

  test("A REWIND DEEPER THAN THE TOLERANCE HALTS PAYOUTS, and says what would release it", async () => {
    indexHeights(1000, 1099);
    const { auditor } = auditorOver({}, { head: 999, depth: 10 });

    await auditor.checkForRewind();

    expect(isKillSwitchTripped(db)).toBe(true);
    expect(getChainHalt(db)).toEqual({ height: 1099, cause: "rewind" });
    expect(listOpenAlerts(db).map((a) => a.kind)).toEqual(["chain_rewound"]);
  });

  test("a shallow rewind is repaired without stopping the money", async () => {
    indexHeights(1000, 1009);
    const { auditor } = auditorOver({}, { head: 1006, depth: 10 });

    await auditor.checkForRewind();

    expect(isKillSwitchTripped(db)).toBe(false);
    expect(listOpenAlerts(db)).toHaveLength(0);
    expect(listUnnotifiedAlerts(db).map((a) => a.kind)).toEqual(["chain_rewound"]);
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("17.5"); // 1000..1006
  });

  test("MONEY ALREADY GONE: a rewind over a paid accrual halts and opens an incident", async () => {
    indexHeights(1000, 1002);
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 0 });
    const { auditor } = auditorOver({}, { head: 1001, depth: 10 });

    await auditor.checkForRewind();

    expect(listOpenAlerts(db).map((a) => a.kind)).toEqual(["reorg_paid_accrual"]);
    expect(isKillSwitchTripped(db)).toBe(true);
  });

  test("SILENCE IS NOT EVIDENCE: an unreachable node rewinds nothing", async () => {
    indexHeights(1000, 1009);
    const { auditor, resumedFrom } = auditorOver({}); // head lookup throws

    expect((await auditor.checkForRewind()).kind).toBe("unchecked");
    expect(resumedFrom).toEqual([]);
    expect(activeBlockRewardsAtHeight(db, 1009)).toHaveLength(1);
  });

  test("A LOST CACHE WRITE IS RETRIED: a walker still parked past the head is re-pointed", async () => {
    // The walker persists its own position at the end of every cycle, so a
    // rewind written mid-cycle is simply lost. Nothing in the ledger shows it:
    // the rows above the head are already orphaned.
    record({ blockId: "block-999", height: 999 });
    const resumedFrom: number[] = [];
    const auditor = createReorgAuditor({
      db,
      depth: 10,
      canonicalBlockIdAt: async () => { throw new Error("unused"); },
      reindex: async () => {},
      nodeHeadHeight: async () => 999,
      indexerPosition: async () => 1099,
      resumeIndexingFrom: async (height) => { resumedFrom.push(height); },
    });

    expect((await auditor.checkForRewind()).kind).toBe("rewound");
    expect(resumedFrom).toEqual([999]);
  });

  test("repairing twice rolls nothing back a second time", async () => {
    indexHeights(1000, 1099);
    const { auditor } = auditorOver({}, { head: 999, depth: 10 });

    await auditor.checkForRewind();
    const second = await auditor.checkForRewind();

    // Nothing is left above the head to roll back, and the incident is not
    // re-raised every minute for as long as the halt lasts.
    expect(second.kind).toBe("none");
    expect(listOpenAlerts(db)).toHaveLength(1);
  });
});

describe("scrubber", () => {
  /** Heights 1000..1099 indexed, with the node agreeing about all of them. */
  const settledChain = () => {
    const chain: Record<number, string> = {};
    for (let height = 1000; height <= 1099; height++) {
      record({ blockId: `block-${height}`, height });
      chain[height] = `block-${height}`;
    }
    return chain;
  };

  test("A BRANCH SWAPPED IN LONG AFTER THE SWEEP PASSED is still caught", async () => {
    // The exact shape the forward sweep cannot see: height 1010 was verified
    // when the tip was 1020, and only replaced later — with the head no lower
    // than before, so the rewind check has nothing to look at either.
    const chain = settledChain();
    const { auditor } = auditorOver(chain, { scrubWindow: 100, scrubBatch: 100 });
    setReorgAuditHeight(db, 1089);
    chain[1010] = "swapped-in";

    await auditor.scrub();

    expect(getBlockReward(db, "block-1010")?.status).toBe("orphaned");
    expect(getBlockReward(db, "swapped-in")?.status).toBe("accrued");
  });

  test("it leaves the unsettled heights to the forward sweep", async () => {
    const chain = settledChain();
    const { auditor, reindexed } = auditorOver(chain, { depth: 10, scrubBatch: 100 });
    // Within depth of the tip: too fresh for anyone to act on yet.
    chain[1095] = "too-fresh";

    await auditor.scrub();

    expect(reindexed).toEqual([]);
    expect(getBlockReward(db, "block-1095")?.status).toBe("accrued");
  });

  test("the rotation covers the whole window and then starts again", async () => {
    const chain = settledChain();
    const { auditor } = auditorOver(chain, { depth: 10, scrubWindow: 20, scrubBatch: 5 });

    // 1070..1089 is the window; four passes of five cover it.
    for (let pass = 0; pass < 4; pass++) await auditor.scrub();
    chain[1070] = "swapped-in";
    // The fifth pass has wrapped back to the start of the window.
    await auditor.scrub();

    expect(getBlockReward(db, "block-1070")?.status).toBe("orphaned");
  });

  test("A SKIPPED HEIGHT IS NOT RETRIED IMMEDIATELY: the rotation keeps moving", async () => {
    const chain = settledChain();
    delete chain[1070]; // the node will not answer for this one
    const { auditor } = auditorOver(chain, { depth: 10, scrubWindow: 20, scrubBatch: 5 });

    const outcomes = await auditor.scrub();

    expect(outcomes.map((o) => o.kind)).toEqual(["unchecked", "intact", "intact", "intact", "intact"]);
  });

  test("MONEY ALREADY GONE: a paid block found by the scrubber halts payouts", async () => {
    const chain = settledChain();
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 0 });
    const { auditor } = auditorOver(chain, { scrubWindow: 100, scrubBatch: 100 });
    chain[1010] = "swapped-in";

    await auditor.scrub();

    expect(listOpenAlerts(db).map((a) => a.kind)).toEqual(["reorg_paid_accrual"]);
    expect(isKillSwitchTripped(db)).toBe(true);
  });

  test("an empty ledger scrubs nothing", async () => {
    const { auditor } = auditorOver({});
    expect(await auditor.scrub()).toEqual([]);
  });
});
