import type { Ledger } from "./db.ts";

export type Severity = "warning" | "critical";

export interface AlertRow {
  id: number;
  kind: string;
  severity: Severity;
  message: string;
  openedAt: number;
  resolvedAt: number | null;
}

/**
 * Opens an incident, or does nothing if one of this kind is already open.
 *
 * Dedup is enforced by the partial unique index ix_alert_open rather than by
 * this code, so a flapping condition physically cannot spam the operator even
 * if a caller loops.
 */
export function openAlert(
  db: Ledger,
  params: { kind: string; severity: Severity; message: string },
): void {
  db.query(
    `INSERT OR IGNORE INTO alerts (kind, severity, message, opened_at) VALUES (?1, ?2, ?3, ?4)`,
  ).run(params.kind, params.severity, params.message, Math.floor(Date.now() / 1000));
}

/**
 * Records something the operator should be told about that is NOT an open
 * incident: a fork that healed, payouts released again after a halt.
 *
 * Opened and resolved in the same breath, deliberately. The notifier delivers
 * on `notified_at`, not on `resolved_at`, so a notice reaches every channel
 * exactly once while never appearing as an open alert — a permanent "all is
 * well" row in the open list would make the status page read degraded forever
 * and would block the next real incident of that kind through ix_alert_open.
 */
export function recordNotice(
  db: Ledger,
  params: { kind: string; severity: Severity; message: string },
): void {
  const at = Math.floor(Date.now() / 1000);
  db.query(
    `INSERT INTO alerts (kind, severity, message, opened_at, resolved_at) VALUES (?1, ?2, ?3, ?4, ?4)`,
  ).run(params.kind, params.severity, params.message, at);
}

export function resolveAlert(db: Ledger, kind: string): void {
  db.query("UPDATE alerts SET resolved_at = ?1 WHERE kind = ?2 AND resolved_at IS NULL").run(
    Math.floor(Date.now() / 1000),
    kind,
  );
}

function toRow(row: Record<string, unknown>): AlertRow {
  return {
    id: row.id as number,
    kind: row.kind as string,
    severity: row.severity as Severity,
    message: row.message as string,
    openedAt: row.opened_at as number,
    resolvedAt: (row.resolved_at as number | null) ?? null,
  };
}

const ALERT_COLUMNS = "id, kind, severity, message, opened_at, resolved_at";

export function listOpenAlerts(db: Ledger): AlertRow[] {
  const rows = db
    .query(`SELECT ${ALERT_COLUMNS} FROM alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC`)
    .all() as Record<string, unknown>[];
  return rows.map(toRow);
}

/**
 * Alerts not yet delivered to any channel.
 *
 * If the Pi has no internet, notification fails and rows stay here, so they are
 * delivered on reconnect rather than lost.
 */
export function listUnnotifiedAlerts(db: Ledger): AlertRow[] {
  const rows = db
    .query(`SELECT ${ALERT_COLUMNS} FROM alerts WHERE notified_at IS NULL ORDER BY opened_at ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(toRow);
}

/**
 * Takes exclusive ownership of an alert's delivery, for `leaseSeconds`.
 *
 * The whole point is that this is ONE statement. Delivery used to be
 * read-the-queue, send, then mark: any second flush overlapping the first read
 * the same undelivered row and sent it again. That is not hypothetical — a
 * `bun --hot` session accumulated twelve notifier timers, every one of them
 * fired in the same tick, and one chain fork arrived as ten emails.
 *
 * The lease expires rather than being held forever, so a process that dies
 * mid-send does not bury the alert: the next flush reclaims it and tries again.
 * That means the guarantee is at-least-once with a window of `leaseSeconds`,
 * not exactly-once — which is the right trade for an alerting path, where a
 * rare duplicate is survivable and a silently dropped incident is not.
 *
 * @returns true if THIS caller now owns delivery and should send.
 */
export function claimAlertForNotification(
  db: Ledger,
  id: number,
  opts: { leaseSeconds: number; nowSeconds?: number },
): boolean {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const result = db
    .query(
      `UPDATE alerts SET notify_lease_at = ?1
        WHERE id = ?2
          AND notified_at IS NULL
          AND (notify_lease_at IS NULL OR notify_lease_at <= ?3)`,
    )
    .run(now, id, now - opts.leaseSeconds);
  return result.changes === 1;
}

/**
 * Hands the alert back after a failed delivery, so the next flush retries it
 * immediately instead of waiting out the lease.
 */
export function releaseAlertClaim(db: Ledger, id: number): void {
  db.query("UPDATE alerts SET notify_lease_at = NULL WHERE id = ?1 AND notified_at IS NULL").run(id);
}

export function markAlertNotified(db: Ledger, id: number, channels: string[]): void {
  db.query("UPDATE alerts SET notified_at = ?1, notified_channels = ?2 WHERE id = ?3").run(
    Math.floor(Date.now() / 1000),
    channels.join(","),
    id,
  );
}
