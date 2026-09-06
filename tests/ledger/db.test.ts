import { test, expect, describe } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";

describe("openLedger", () => {
  test("creates every expected table and view", () => {
    const db = openLedger(":memory:");
    const names = db
      .query("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all() as { name: string }[];
    const set = new Set(names.map((n) => n.name));
    for (const expected of [
      "block_rewards",
      "batches",
      "batch_recipients",
      "mainnet_accounts",
      "health_samples",
      "alerts",
      "service_state",
      "unpaid_accruals",
    ]) {
      expect(set.has(expected)).toBe(true);
    }
    db.close();
  });

  test("applying the schema twice is harmless", () => {
    const db = openLedger(":memory:");
    expect(() => openLedger(":memory:")).not.toThrow();
    db.close();
  });

  test("enforces one open alert per kind", () => {
    const db = openLedger(":memory:");
    const ins = db.query(
      "INSERT INTO alerts (kind, severity, message, opened_at) VALUES (?1, 'critical', 'x', 1)",
    );
    ins.run("testnet_stalled");
    expect(() => ins.run("testnet_stalled")).toThrow();
    db.close();
  });

  test("allows a new alert of the same kind once the previous is resolved", () => {
    const db = openLedger(":memory:");
    db.run(
      "INSERT INTO alerts (kind, severity, message, opened_at) VALUES ('low_peers','warning','x',1)",
    );
    db.run("UPDATE alerts SET resolved_at = 2 WHERE kind = 'low_peers'");
    expect(() =>
      db.run(
        "INSERT INTO alerts (kind, severity, message, opened_at) VALUES ('low_peers','warning','x',3)",
      ),
    ).not.toThrow();
    db.close();
  });

  test("enables foreign keys", () => {
    const db = openLedger(":memory:");
    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });
});
