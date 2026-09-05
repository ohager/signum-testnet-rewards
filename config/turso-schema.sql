-- Public read-model. Disposable: rebuildable at any time from the Pi's ledger.
-- Contains no secrets and no internal error detail.

CREATE TABLE IF NOT EXISTS status (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at               INTEGER NOT NULL,
  service_status           TEXT    NOT NULL,
  payouts_enabled          INTEGER NOT NULL,
  payouts_paused           INTEGER NOT NULL,
  kill_switch              INTEGER NOT NULL,
  testnet_height           INTEGER,
  seconds_since_last_block INTEGER,
  peer_count               INTEGER,
  reward_per_block_planck  INTEGER,
  budget_remaining_planck  INTEGER,
  total_distributed_planck INTEGER,
  distributed_24h_planck   INTEGER,
  next_payout_at           INTEGER,
  open_alerts              TEXT
);

CREATE TABLE IF NOT EXISTS miners (
  account_id       TEXT PRIMARY KEY,
  address          TEXT,
  blocks_mined     INTEGER NOT NULL,
  blocks_skipped   INTEGER NOT NULL,
  pending_planck   INTEGER NOT NULL,
  paid_planck      INTEGER NOT NULL,
  last_block_at    INTEGER,
  last_skip_reason TEXT,
  cap_reached      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payouts (
  batch_id        INTEGER PRIMARY KEY,
  tx_id           TEXT,
  confirmed_at    INTEGER,
  recipient_count INTEGER,
  total_planck    INTEGER
);

-- Populated in Phase 2, once real batches confirm.
CREATE TABLE IF NOT EXISTS payout_recipients (
  batch_id      INTEGER NOT NULL,
  recipient_id  TEXT    NOT NULL,
  amount_planck INTEGER NOT NULL,
  PRIMARY KEY (batch_id, recipient_id)
);

-- Populated when the status page that charts it is built.
CREATE TABLE IF NOT EXISTS health_history (
  sampled_at               INTEGER PRIMARY KEY,
  status                   TEXT,
  peer_count               INTEGER,
  seconds_since_last_block INTEGER
);
