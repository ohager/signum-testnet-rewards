/**
 * Ledger DDL. Applied on every startup; every statement is IF NOT EXISTS so it
 * is safe to re-run.
 *
 * Amounts are INTEGER planck: 1 SIGNA = 1e8 planck, so the JS safe-integer
 * range covers ~90 million SIGNA, far beyond anything this service moves.
 * Keeping them integers lets SQL SUM() stay exact.
 *
 * `batches` is created before `block_rewards` because the latter has a foreign
 * key referencing it.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS batches (
  id               INTEGER PRIMARY KEY,
  status           TEXT NOT NULL,
  recipient_count  INTEGER,
  total_planck     INTEGER,
  fee_planck       INTEGER,
  tx_id            TEXT,
  full_hash        TEXT,
  deadline_at      INTEGER,
  broadcast_at     INTEGER,
  confirmed_at     INTEGER,
  confirmed_height INTEGER,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_batches_status ON batches(status);

CREATE TABLE IF NOT EXISTS block_rewards (
  block_id             TEXT    PRIMARY KEY,
  height               INTEGER NOT NULL,
  block_timestamp      INTEGER NOT NULL,
  chain_day            TEXT    NOT NULL,
  generator_id         TEXT    NOT NULL,
  generator_public_key TEXT    NOT NULL,
  status               TEXT    NOT NULL,
  amount_planck        INTEGER NOT NULL DEFAULT 0,
  batch_id             INTEGER REFERENCES batches(id),
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_br_acct_day  ON block_rewards(generator_id, chain_day);
CREATE INDEX IF NOT EXISTS ix_br_day       ON block_rewards(chain_day);
CREATE INDEX IF NOT EXISTS ix_br_height    ON block_rewards(height);
CREATE INDEX IF NOT EXISTS ix_br_unbatched ON block_rewards(batch_id)
  WHERE status = 'accrued' AND batch_id IS NULL;

CREATE TABLE IF NOT EXISTS batch_recipients (
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  recipient_id  TEXT    NOT NULL,
  amount_planck INTEGER NOT NULL,
  PRIMARY KEY (batch_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS mainnet_accounts (
  account_id      TEXT PRIMARY KEY,
  public_key      TEXT,
  is_active       INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS health_samples (
  id                       INTEGER PRIMARY KEY,
  sampled_at               INTEGER NOT NULL,
  local_height             INTEGER,
  global_height            INTEGER,
  in_sync                  INTEGER,
  peer_count               INTEGER,
  seconds_since_last_block INTEGER,
  wallet_balance_planck    INTEGER,
  status                   TEXT
);
CREATE INDEX IF NOT EXISTS ix_health_time ON health_samples(sampled_at);

CREATE TABLE IF NOT EXISTS alerts (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL,
  severity          TEXT NOT NULL,
  message           TEXT NOT NULL,
  opened_at         INTEGER NOT NULL,
  resolved_at       INTEGER,
  notified_at       INTEGER,
  notified_channels TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_alert_open ON alerts(kind) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS service_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

CREATE VIEW IF NOT EXISTS unpaid_accruals AS
  SELECT * FROM block_rewards WHERE status = 'accrued' AND batch_id IS NULL;
`;
