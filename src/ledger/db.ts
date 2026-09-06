import { Database } from "bun:sqlite";
import { SCHEMA_SQL, ADDED_COLUMNS } from "./schema.ts";

export type Ledger = Database;

/**
 * Opens (or creates) the ledger and applies the schema.
 *
 * Callers MUST have run assertDataVolumeMounted() first for a real path:
 * SQLite will happily create a database on an unmounted mountpoint.
 */
export function openLedger(path: string): Ledger {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(SCHEMA_SQL);
  applyAddedColumns(db);
  return db;
}

/**
 * Adds columns introduced after a database was first created.
 *
 * Checked against PRAGMA table_info rather than run-and-catch, so a genuine
 * ALTER failure surfaces instead of being swallowed as "already applied".
 */
function applyAddedColumns(db: Ledger): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue;
    if (columns.some((c) => c.name === column)) continue;
    db.run(ddl);
  }
}
