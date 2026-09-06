import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { pruneLedger } from "../../src/ledger/retention.ts";
import { openAlert, resolveAlert, listOpenAlerts } from "../../src/ledger/alerts.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { upsertAccount } from "../../src/ledger/mainnetAccounts.ts";
import { recordHealthSample } from "../../src/ledger/healthSamples.ts";

// Anchored to the real clock: openAlert and resolveAlert stamp rows with
// Date.now(), so a fixed future NOW would make a freshly resolved alert look
// older than the cutoff.
const NOW = Math.floor(Date.now() / 1000);
const CUTOFF = NOW - 30 * 86_400;

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

const count = (table: string): number =>
  (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe("pruneLedger", () => {
  test("drops health samples past the window and keeps the rest", () => {
    recordHealthSample(db, {
      sampledAt: CUTOFF - 1, localHeight: 1, globalHeight: 1,
      inSync: true, peerCount: 8, secondsSinceLastBlock: 10, status: "ok",
    });
    recordHealthSample(db, {
      sampledAt: NOW, localHeight: 2, globalHeight: 2,
      inSync: true, peerCount: 8, secondsSinceLastBlock: 10, status: "ok",
    });

    expect(pruneLedger(db, CUTOFF).healthSamples).toBe(1);
    expect(count("health_samples")).toBe(1);
  });

  test("AN OPEN ALERT IS CURRENT STATE, NOT HISTORY: it survives any age", () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "old but open" });
    db.query("UPDATE alerts SET opened_at = ?1").run(CUTOFF - 86_400);

    expect(pruneLedger(db, CUTOFF).alerts).toBe(0);
    expect(listOpenAlerts(db)).toHaveLength(1);
  });

  test("a resolved alert past the window is dropped", () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "done" });
    resolveAlert(db, "low_peers");
    db.query("UPDATE alerts SET resolved_at = ?1").run(CUTOFF - 1);

    expect(pruneLedger(db, CUTOFF).alerts).toBe(1);
    expect(count("alerts")).toBe(0);
  });

  test("a recently resolved alert is kept", () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "recent" });
    resolveAlert(db, "low_peers");

    expect(pruneLedger(db, CUTOFF).alerts).toBe(0);
    expect(count("alerts")).toBe(1);
  });

  test("a stale mainnet account cache entry is dropped and re-fetched later", () => {
    upsertAccount(db, { accountId: "a", publicKey: "pk", isActive: true }, CUTOFF - 1);
    upsertAccount(db, { accountId: "b", publicKey: "pk", isActive: true }, NOW);

    expect(pruneLedger(db, CUTOFF).mainnetAccounts).toBe(1);
    expect(count("mainnet_accounts")).toBe(1);
  });

  test("THE DOUBLE-PAY GUARD IS NEVER PRUNED: block rewards survive any age", () => {
    recordBlockReward(db, {
      blockId: "ancient", height: 1, blockTimestamp: 1, chainDay: "2020-01-01",
      generatorId: "acct-1", generatorPublicKey: "pk-1",
      status: "accrued", amount: Amount.fromSigna("2.5"),
    });
    db.query("UPDATE block_rewards SET created_at = ?1").run(CUTOFF - 86_400 * 365);

    pruneLedger(db, CUTOFF);
    expect(count("block_rewards")).toBe(1);
  });
});
