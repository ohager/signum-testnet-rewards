import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import {
  openAlert, resolveAlert, listOpenAlerts, listUnnotifiedAlerts, markAlertNotified,
} from "../../src/ledger/alerts.ts";

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

describe("alerts", () => {
  test("opening an alert records it as open", () => {
    openAlert(db, { kind: "testnet_stalled", severity: "critical", message: "no blocks 17m" });
    const open = listOpenAlerts(db);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("testnet_stalled");
  });
  test("DEDUP: opening the same kind twice does not create a second incident", () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "2 peers" });
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });
    expect(listOpenAlerts(db)).toHaveLength(1);
  });
  test("DEDUP: a flapping condition cannot spam, even across many attempts", () => {
    for (let i = 0; i < 50; i++) {
      openAlert(db, { kind: "low_peers", severity: "warning", message: `attempt ${i}` });
    }
    expect(listOpenAlerts(db)).toHaveLength(1);
  });
  test("resolving lets the same kind open again as a new incident", () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "first" });
    resolveAlert(db, "low_peers");
    expect(listOpenAlerts(db)).toHaveLength(0);
    openAlert(db, { kind: "low_peers", severity: "warning", message: "second" });
    expect(listOpenAlerts(db)).toHaveLength(1);
    const all = db.query("SELECT COUNT(*) AS c FROM alerts").get() as { c: number };
    expect(all.c).toBe(2);
  });
  test("resolving an alert that is not open is harmless", () => {
    expect(() => resolveAlert(db, "never_opened")).not.toThrow();
  });
  test("unnotified alerts are queued until marked, which supports offline retry", () => {
    openAlert(db, { kind: "wallet_low", severity: "warning", message: "low" });
    expect(listUnnotifiedAlerts(db)).toHaveLength(1);
    const alert = listUnnotifiedAlerts(db)[0];
    expect(alert).toBeDefined();
    markAlertNotified(db, alert!.id, ["telegram", "discord"]);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);
  });
});
