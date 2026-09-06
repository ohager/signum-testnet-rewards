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

export function markAlertNotified(db: Ledger, id: number, channels: string[]): void {
  db.query("UPDATE alerts SET notified_at = ?1, notified_channels = ?2 WHERE id = ?3").run(
    Math.floor(Date.now() / 1000),
    channels.join(","),
    id,
  );
}
