import type { Ledger } from "./db.ts";

const PAYOUTS_PAUSED = "payouts_paused";
const KILL_SWITCH = "kill_switch";
const KILL_SWITCH_REASON = "kill_switch_reason";
const CHAIN_HALT = "chain_halt";
const REORG_AUDIT_HEIGHT = "reorg_audit_height";

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

/**
 * Releases the halt, whoever released it.
 *
 * The halt record goes with it: it exists only to answer "is this halt safe to
 * lift yet", and an operator clearing the switch by hand has answered that
 * question themselves. Leaving it behind would have the next event judged
 * against a height from the last one.
 */
export function clearKillSwitch(db: Ledger): void {
  setState(db, KILL_SWITCH, "false");
  deleteState(db, KILL_SWITCH_REASON);
  deleteState(db, CHAIN_HALT);
}

export function getKillSwitchReason(db: Ledger): string | undefined {
  return getState(db, KILL_SWITCH_REASON);
}

/** Why payouts were halted, and the height the trouble was seen at. */
export type ChainHaltCause = "fork" | "rewind";

export interface ChainHalt {
  height: number;
  cause: ChainHaltCause;
}

/**
 * Records what a halt was about, alongside the kill switch it tripped.
 *
 * Kept because the halt outlives the event. "The fork is gone" is not the
 * question that matters later; the question is whether anything we accrued at
 * or above that height was on the losing branch, and answering it needs to know
 * where to look and what happened. Cleared when the halt is released.
 */
export function recordChainHalt(db: Ledger, halt: ChainHalt): void {
  setState(db, CHAIN_HALT, JSON.stringify(halt));
}

export function getChainHalt(db: Ledger): ChainHalt | undefined {
  const raw = getState(db, CHAIN_HALT);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as ChainHalt;
    return typeof parsed?.height === "number" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The highest block height the reorg audit has verified against the node.
 *
 * Persisted rather than held in memory so a restart resumes the sweep instead
 * of silently declaring every earlier height settled.
 */
export function getReorgAuditHeight(db: Ledger): number | undefined {
  const raw = getState(db, REORG_AUDIT_HEIGHT);
  if (raw === undefined) return undefined;
  const height = Number(raw);
  return Number.isFinite(height) ? height : undefined;
}

export function setReorgAuditHeight(db: Ledger, height: number): void {
  setState(db, REORG_AUDIT_HEIGHT, String(height));
}
