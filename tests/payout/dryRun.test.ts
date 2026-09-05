import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { aggregateUnpaidByRecipient } from "../../src/ledger/batches.ts";
import { dryRunBatch } from "../../src/payout/dryRun.ts";
import type { RailsConfig } from "../../src/domain/rails.ts";

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

const rails: RailsConfig = {
  maxPerRecipientPerBatch: Amount.fromSigna("200"),
  maxPerBatch: Amount.fromSigna("2000"),
  maxPerWallClockDay: Amount.fromSigna("3000"),
};

const accrue = (blockId: string, generatorId: string, signa: string) =>
  recordBlockReward(db, {
    blockId, height: 1, blockTimestamp: 1, chainDay: "2026-03-14",
    generatorId, generatorPublicKey: "pk", status: "accrued",
    amount: Amount.fromSigna(signa),
  });

const opts = () => ({ minPayout: Amount.fromSigna("5"), rails, spentToday: Amount.Zero() });

describe("dryRunBatch", () => {
  test("reports what would be sent without changing anything", () => {
    accrue("b1", "acct-1", "10");
    accrue("b2", "acct-2", "10");
    const beforeCount = aggregateUnpaidByRecipient(db).length;
    const report = dryRunBatch(db, opts());
    expect(report.wouldSend).toBe(true);
    expect(report.draft.recipients).toHaveLength(2);
    expect(report.draft.total.getSigna()).toBe("20");
    expect(report.railsVerdict).toEqual({ ok: true });
    // NOTHING was claimed.
    expect(aggregateUnpaidByRecipient(db)).toHaveLength(beforeCount);
    const batches = db.query("SELECT COUNT(*) AS c FROM batches").get() as { c: number };
    expect(batches.c).toBe(0);
  });
  test("reports a rail violation instead of a sendable batch", () => {
    accrue("b1", "acct-1", "500");
    const report = dryRunBatch(db, opts());
    expect(report.wouldSend).toBe(false);
    expect(report.railsVerdict.ok).toBe(false);
  });
  test("reports nothing to send when the pool is empty", () => {
    const report = dryRunBatch(db, opts());
    expect(report.wouldSend).toBe(false);
    expect(report.draft.recipients).toHaveLength(0);
  });
  test("reports nothing to send when everything is below the dust threshold", () => {
    accrue("b1", "acct-1", "0.5");
    const report = dryRunBatch(db, opts());
    expect(report.wouldSend).toBe(false);
    expect(report.deferredDust).toHaveLength(1);
  });
});
