import type { Ledger } from "./db.ts";

const PAYOUTS_PAUSED = "payouts_paused";
const KILL_SWITCH = "kill_switch";
const KILL_SWITCH_REASON = "kill_switch_reason";

export function getState(db: Ledger, key: string): string | undefined {
  const row = db.query("SELECT value FROM service_state WHERE key = ?1").get(key) as
    | { value: string | null }
    | null;
  return row?.value ?? undefined;
}

export function setState(db: Ledger, key: string, value: string): void {
  db.query(
    `INSERT INTO service_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Math.floor(Date.now() / 1000));
}

export function deleteState(db: Ledger, key: string): void {
  db.query("DELETE FROM service_state WHERE key = ?1").run(key);
}

export function isPayoutsPaused(db: Ledger): boolean {
  return getState(db, PAYOUTS_PAUSED) === "true";
}

export function setPayoutsPaused(db: Ledger, paused: boolean): void {
  setState(db, PAYOUTS_PAUSED, paused ? "true" : "false");
}

export function isKillSwitchTripped(db: Ledger): boolean {
  return getState(db, KILL_SWITCH) === "true";
}

/**
 * Halts all payouts. Deliberately has no automatic reset: a rail violation means
 * something is wrong that a human should look at. Accrual and indexing continue,
 * so miners keep earning and only delivery pauses.
 */
export function tripKillSwitch(db: Ledger, reason: string): void {
  setState(db, KILL_SWITCH, "true");
  setState(db, KILL_SWITCH_REASON, reason);
}

export function clearKillSwitch(db: Ledger): void {
  setState(db, KILL_SWITCH, "false");
  deleteState(db, KILL_SWITCH_REASON);
}

export function getKillSwitchReason(db: Ledger): string | undefined {
  return getState(db, KILL_SWITCH_REASON);
}
