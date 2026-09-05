import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema.ts";

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
  return db;
}
