/**
 * DDL for the published read-model.
 *
 * This is the ONLY place the remote shape is declared, and it is applied by the
 * publisher itself on first push. The remote database is a projection, never a
 * source of truth: it can be dropped at any time and the next tick rebuilds it
 * from the local ledger. That is why bootstrapping is a plain
 * `CREATE TABLE IF NOT EXISTS` script rather than a migration system — there is
 * no remote state worth migrating.
 *
 * Amounts are INTEGER planck, matching the local ledger, so no rounding is
 * introduced by publishing.
 *
 * Keep every column in step with the INSERTs in `tursoPublisher.ts`: a column
 * missing here surfaces as a runtime SQL error on the first push. Adding one is
 * safe against a remote created by an older build — the bootstrap reconciles
 * missing columns with ALTER TABLE, so every column added after the first
 * release MUST be nullable or carry a DEFAULT.
 */
export const PUBLISH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS status (
  id                       INTEGER PRIMARY KEY,
  updated_at               INTEGER NOT NULL,
  service_status           TEXT    NOT NULL,
  payouts_enabled          INTEGER NOT NULL DEFAULT 0,
  payouts_paused           INTEGER NOT NULL DEFAULT 0,
  kill_switch              INTEGER NOT NULL DEFAULT 0,
  budget_remaining_planck  INTEGER NOT NULL DEFAULT 0,
  total_distributed_planck INTEGER NOT NULL DEFAULT 0,
  pending_planck           INTEGER NOT NULL DEFAULT 0,
  miner_count              INTEGER NOT NULL DEFAULT 0,
  next_payout_at           INTEGER,
  payout_blocked_by        TEXT,
  payout_due               INTEGER NOT NULL DEFAULT 0,
  last_payout_at           INTEGER,
  open_alerts              TEXT    NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS miners (
  account_id       TEXT    PRIMARY KEY,
  account_rs       TEXT,
  mainnet_account  TEXT,
  blocks_mined     INTEGER NOT NULL DEFAULT 0,
  blocks_skipped   INTEGER NOT NULL DEFAULT 0,
  pending_planck   INTEGER NOT NULL DEFAULT 0,
  paid_planck      INTEGER NOT NULL DEFAULT 0,
  last_block_at    INTEGER,
  last_skip_reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_miners_pending ON miners(pending_planck DESC);
CREATE INDEX IF NOT EXISTS ix_miners_paid ON miners(paid_planck DESC);

CREATE TABLE IF NOT EXISTS payouts (
  batch_id        INTEGER PRIMARY KEY,
  tx_id           TEXT,
  confirmed_at    INTEGER,
  recipient_count INTEGER,
  total_planck    INTEGER
);
CREATE INDEX IF NOT EXISTS ix_payouts_confirmed ON payouts(confirmed_at DESC);
`;

export interface SchemaColumn {
  name: string;
  /** Everything after the name, ready to follow `ALTER TABLE … ADD COLUMN <name>`. */
  definition: string;
}

const TABLE_RE = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
const TABLE_CONSTRAINTS = /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i;

/**
 * Reads the expected columns back out of the DDL above.
 *
 * Deriving them rather than restating them keeps ONE source of truth: a column
 * added to `PUBLISH_SCHEMA_SQL` is automatically reconciled onto a remote
 * created by an older build, and the two lists cannot drift apart.
 *
 * Only the simple `name TYPE …` column form is understood, which is all this
 * schema uses; table-level constraints are skipped.
 */
export function parseSchemaColumns(sql: string): Map<string, SchemaColumn[]> {
  const tables = new Map<string, SchemaColumn[]>();

  for (const [, table, body] of sql.matchAll(TABLE_RE)) {
    const columns = (body ?? "")
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => line.length > 0 && !TABLE_CONSTRAINTS.test(line))
      .map((line) => {
        const at = line.indexOf(" ");
        return { name: line.slice(0, at), definition: line.slice(at + 1).trim() };
      });
    tables.set(table!, columns);
  }

  return tables;
}
