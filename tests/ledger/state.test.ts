import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import {
  getState, setState, isPayoutsPaused, setPayoutsPaused,
  isKillSwitchTripped, tripKillSwitch, clearKillSwitch, getKillSwitchReason,
} from "../../src/ledger/state.ts";

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

describe("service state", () => {
  test("returns undefined for an unset key", () => {
    expect(getState(db, "nothing")).toBeUndefined();
  });
  test("round-trips a value and overwrites on second write", () => {
    setState(db, "k", "v1");
    expect(getState(db, "k")).toBe("v1");
    setState(db, "k", "v2");
    expect(getState(db, "k")).toBe("v2");
  });
  test("payouts are not paused by default", () => {
    expect(isPayoutsPaused(db)).toBe(false);
  });
  test("pausing and resuming payouts", () => {
    setPayoutsPaused(db, true);
    expect(isPayoutsPaused(db)).toBe(true);
    setPayoutsPaused(db, false);
    expect(isPayoutsPaused(db)).toBe(false);
  });
  test("kill switch is untripped by default and records its reason when tripped", () => {
    expect(isKillSwitchTripped(db)).toBe(false);
    tripKillSwitch(db, "per_batch rail exceeded");
    expect(isKillSwitchTripped(db)).toBe(true);
    expect(getKillSwitchReason(db)).toBe("per_batch rail exceeded");
  });
  test("clearing the kill switch is explicit and removes the reason", () => {
    tripKillSwitch(db, "boom");
    clearKillSwitch(db);
    expect(isKillSwitchTripped(db)).toBe(false);
    expect(getKillSwitchReason(db)).toBeUndefined();
  });
});
