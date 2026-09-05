# Signum Testnet Rewards — Design

**Date:** 2026-09-05
**Status:** Approved design, ready for implementation planning

## Purpose

Reward Signum **testnet** miners with real **mainnet** SIGNA, automatically and unattended, from a Raspberry Pi 4 on a local network. Provide a public status page so miners can see what they have earned and whether the testnet is healthy, and alert the operator when the testnet stalls or the service misbehaves.

## Constraints

- Runs on a Pi4 under pm2, using Bun.
- Pi is LAN-only, no inbound internet. Threat model is therefore **bugs, not intruders**.
- Payout wallet seed lives in `.env` on the Pi.
- Public status page is hosted on Vercel (Next.js) and must never reach back into the payout service.
- A HDD is attached to the Pi (currently holding mining plots); it hosts the service's data directory.

---

## 1. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Fixed reward per mined testnet block, with a per-account daily cap and a global daily budget | Predictable and simple; caps stop one high-capacity miner draining the pot |
| D2 | Testnet generator is paid at the **same numeric account ID** on mainnet, only if that account is active there | Signum account IDs derive from the public key, so the mapping proves itself — no registration flow needed |
| D3 | Payouts are **batched multi-out** on an interval | Far fewer fees and far less signing traffic than per-block sends |
| D4 | Local `bun:sqlite` is the authoritative ledger; Turso holds a **disposable public read-model** | Payout correctness never depends on cloud availability, and no beta features sit on the money path |
| D5 | Local testnet node on the Pi; mainnet reached via a **pool of public nodes with failover** | The local testnet node is also the health subject; a Pi4 should not host two chains |
| D6 | Alerts fan out to status page + Telegram + Discord + email (Resend) | Operator wants push notification; community benefits from the public signal |
| D7 | LAN-only `Bun.serve` admin UI with operator controls | Controls must live on the Pi; the cloud read-model stays strictly one-way |
| D8 | Single process, one pm2 app, with an **outbox state machine** for payouts | Crash-safe payouts where it matters, without event-sourcing the whole system |
| D9 | Money amounts use `Amount` from `@signumjs/util`; SQLite stores whole planck | Removes planck-vs-SIGNA ambiguity from every signature while keeping SQL `SUM()` exact |
| D10 | Repo relicensed MIT → GPL-3.0-or-later | Enables reuse of signum-node's GPL design system in both UIs |
| D11 | Money config declared in **SIGNA**, not planck | `Amount.fromSigna` parses decimals exactly, and a misplaced zero in a planck literal is the likelier operator error |
| D12 | Turso publishing is **optional** | Absent config disables publishing instead of refusing to boot, so the indexer can be run and verified without a cloud database |

### Rejected alternatives

- **Turso as the only database, or embedded replica with `offline: true`.** Turso's default embedded-replica behaviour is *not* local-first: writes are forwarded to the remote primary and fail when it is unreachable. Local-first writes exist via the `offline` option but are beta. Not acceptable under the money path. ([docs](https://docs.turso.tech/features/embedded-replicas/introduction), [offline writes](https://turso.tech/blog/introducing-offline-writes-for-turso))
- **Two pm2 apps sharing the SQLite file.** Cross-process coordination bugs for no throughput benefit. The isolation wanted here is *module* isolation.
- **Full event sourcing.** The chain is already an immutable audit log for the outgoing half; the extra machinery is not earned.
- **Opt-in mainnet address registry.** Same-ID mapping removes the need entirely.
- **Control channel from Vercel back to the Pi.** Turns a disposable read-model into an attack path into the payout service.

---

## 2. Architecture

### Startup sequence

```
walk(configuredStartHeight)   →  catch up everything missed
        ↓
listen()                       →  steady state
        ↓ (parallel, independent)
WebSocket /events (SIP-50)     →  liveness only, never touches money
```

`ChainWalker.walk()` resumes from its cached height when that exceeds `configuredStartHeight`, so a restart continues where it left off. `blockOffset: 2` means only blocks two deep are processed, so micro-forks resolve before observation.

### The two-cache problem

`chainwalker.cache.json` and `rewards.sqlite` are separate files written at separate moments. A power cut between the SQLite commit and the walker's cache write causes that block to be processed again on restart. This is inherent to having two stores and cannot be made atomic.

The design does not try. Instead, **re-processing a block is made harmless** by two independent idempotency layers:

**Layer 1 — accrual is idempotent on block identity.** `block_rewards` has `block_id` as PRIMARY KEY and inserts use `INSERT OR IGNORE`. Replaying a block is a silent no-op. Keying on `block_id` rather than height means a pop-off that slipped past the offset shows up as an anomaly rather than being silently merged.

**Layer 2 — an accrual belongs to exactly one batch.** `block_rewards.batch_id` is `NULL` until claimed; batching stamps it in a single transaction.

These compose: the walker may replay freely and nobody is paid twice. This is what makes "just restart it" a safe operation.

### Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `ledger` | SQLite schema, accrual and batch queries, all transactions | — |
| `indexer` | Chain-walker wiring, `onBlock` → eligibility → accrual | `ledger`, `eligibility` |
| `eligibility` | Is this generator payable? | mainnet client |
| `policy` | Reward and cap arithmetic. **Pure functions, no I/O** | — |
| `payout` | Outbox state machine, batch building, broadcast, reconciliation | `ledger`, mainnet client |
| `health` | WS liveness, HTTP fallback, node/peer/balance probes | testnet + mainnet clients |
| `publisher` | Read-model projection → Turso | `ledger`, `health` |
| `notifier` | Fan-out to Telegram / Discord / email | — |
| `admin` | LAN `Bun.serve` UI and controls | `ledger`, `payout` |

`policy` is deliberately I/O-free: reward and cap arithmetic is where money bugs live, and pure functions can be tested exhaustively.

### Eligibility

A generator is payable when all hold:

1. An account with the same numeric ID exists on mainnet **and has a public key set** (i.e. it is active).
2. That mainnet public key **equals** the testnet block generator's public key. ID equality already implies this, since the ID derives from the key; the explicit comparison closes the only theoretical hole and costs one string compare. A mismatch is an alert-worthy anomaly, not a silent skip.
3. The account is not on the operator exclusion list.
4. Neither the per-account daily cap nor the global daily budget for that `chain_day` is exhausted.

Mainnet account lookups are cached in `mainnet_accounts` with a TTL — long for positives, short for negatives so a newly activated account starts earning quickly.

---

## 3. Data model

### Local SQLite (`rewards.sqlite`) — authoritative

Amounts are `INTEGER` planck, not strings. 1 SIGNA = 10^8 planck, so JS's safe-integer range covers ~90 million SIGNA — far beyond anything this service moves. This keeps `SUM()` honest in SQL and avoids hand-rolled decimal math on the money path.

```sql
-- One row per observed block. The idempotency anchor.
CREATE TABLE block_rewards (
  block_id             TEXT    PRIMARY KEY,   -- not height: survives pop-offs
  height               INTEGER NOT NULL,
  block_timestamp      INTEGER NOT NULL,      -- signum epoch seconds
  chain_day            TEXT    NOT NULL,      -- 'YYYY-MM-DD' UTC, derived
  generator_id         TEXT    NOT NULL,
  generator_public_key TEXT    NOT NULL,
  status               TEXT    NOT NULL,
  amount_planck        INTEGER NOT NULL DEFAULT 0,
  batch_id             INTEGER REFERENCES batches(id),
  created_at           INTEGER NOT NULL
);
CREATE INDEX ix_br_acct_day  ON block_rewards(generator_id, chain_day);
CREATE INDEX ix_br_height    ON block_rewards(height);
CREATE INDEX ix_br_unbatched ON block_rewards(batch_id)
  WHERE status = 'accrued' AND batch_id IS NULL;

-- The money query, named once so no caller can forget the filters
CREATE VIEW unpaid_accruals AS
  SELECT * FROM block_rewards WHERE status = 'accrued' AND batch_id IS NULL;
```

`status` is one of: `accrued`, `skipped_no_mainnet_account`, `skipped_pubkey_mismatch`, `skipped_excluded`, `skipped_account_cap`, `skipped_global_cap`.

Recording skips rather than dropping them is what lets the status page answer *"why am I not getting paid?"*, which would otherwise become the operator's support burden.

```sql
CREATE TABLE batches (
  id               INTEGER PRIMARY KEY,
  status           TEXT NOT NULL,  -- pending|broadcast|confirmed|failed
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

CREATE TABLE batch_recipients (
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  recipient_id  TEXT    NOT NULL,
  amount_planck INTEGER NOT NULL,
  PRIMARY KEY (batch_id, recipient_id)
);

CREATE TABLE mainnet_accounts (
  account_id      TEXT PRIMARY KEY,
  public_key      TEXT,
  is_active       INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL
);

CREATE TABLE health_samples (
  id INTEGER PRIMARY KEY,
  sampled_at INTEGER NOT NULL,
  local_height INTEGER, global_height INTEGER, in_sync INTEGER,
  peer_count INTEGER, seconds_since_last_block INTEGER,
  wallet_balance_planck INTEGER, status TEXT
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL,
  opened_at INTEGER NOT NULL, resolved_at INTEGER,
  notified_at INTEGER, notified_channels TEXT
);
-- one open incident per kind, enforced by the database
CREATE UNIQUE INDEX ix_alert_open ON alerts(kind) WHERE resolved_at IS NULL;

CREATE TABLE service_state (
  key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER
);
-- payouts_paused, kill_switch, last_publish_watermark, ...
```

The partial unique index on `alerts` does real work: it makes "one open incident per kind" a database guarantee, so a flapping condition physically cannot spam the operator.

### Turso — public read-model, rebuildable

Tables: `status` (single row), `miners`, `payouts`, `payout_recipients` (retained ~90 days), `health_history` (downsampled).

Publishing is **upsert-current-state** for `status`, `miners` and `health_history`, and **append-past-watermark** for `payouts`. Nothing queues: a failed push is redone next tick from live state. No secrets, no seed, and no internal error detail ever cross into Turso.

### Two policy semantics this schema fixes

**`chain_day` is derived from the block timestamp, not wall clock.** If the service is down for three days, catch-up replays three days of blocks in minutes. Under wall-clock accounting all of it lands on "today", instantly exhausting today's global budget and starving the miners currently working. Chain-day accounting gives each day its own budget, is stable across replays, and makes caps a deterministic function of chain data.

**No retroactive rewards for late mainnet activation.** Blocks mined without an active mainnet account are recorded `skipped_no_mainnet_account` and stay that way. Miners start earning once activated; the short negative-cache TTL makes that quick, and the status page explains the zero. Retroactively converting skips to accruals would reopen closed days and undermine the cap arithmetic.

---

## 4. Payout pipeline

**One batch in flight at a time.** With payouts every few hours this costs nothing, and it makes crash recovery decidable rather than ambiguous.

```
 compose ──▶ pending ──▶ broadcast ──▶ confirmed
    │                        │
    │                        └──▶ failed ──▶ accruals released back
    └── rails violated ──▶ kill-switch + alert, nothing sent
```

### Compose — one SQLite transaction, no network calls

- `SELECT generator_id, SUM(amount_planck) FROM unpaid_accruals GROUP BY generator_id`
- Drop recipients under `MIN_PAYOUT_PLANCK` (dust). Their accruals stay unbatched and **roll over** — nothing is lost, we simply do not burn a fee to deliver a trivial amount.
- Order oldest-accrual-first (fairness, not size); take at most **64**. The remainder rolls to the next run.
- Evaluate safety rails. Any violation aborts, trips the kill-switch, alerts, and sends nothing.
- Insert `batches` and `batch_recipients`, stamp `batch_id` onto claimed rows, commit.

The intent is durable *before* anything touches the network.

### Broadcast

`sendAmountToMultipleRecipients` with a short `deadline`, signed locally, sent to the mainnet node pool with failover.

Two constraints imposed by the node (verified in `signum-node/src/brs/Constants.java` and `Attachment.java`):

- `MAX_MULTI_OUT_RECIPIENTS = 64` (arbitrary amounts); `MAX_MULTI_SAME_OUT_RECIPIENTS = 128` (same amount, unused here since amounts differ).
- `Attachment.java` rejects `recipients.size() <= 1`. **A single-recipient batch cannot use multi-out** and must fall back to an ordinary `sendAmount`. This is a normal path on quiet days, not an edge case.

**Fees are paid by the service, not deducted from rewards** — miners receive exactly the advertised amount. Use the node's suggested fee clamped to `MAX_FEE_PLANCK`; a suggested fee above the ceiling is a **deferral** (retry next tick), not a failure.

### Confirmation and crash recovery

Poll until `CONFIRMATIONS_REQUIRED`, record `confirmed_height`, then the batch becomes publishable.

The dangerous window is: broadcast succeeded, but the Pi died before recording `tx_id`. Tagging the batch is not available — multi-out's attachment slot is already occupied by `PaymentMultiOutCreation`, so there is no custom message to search for.

Reconciliation is therefore **fingerprint matching**, made unambiguous by the single-batch-in-flight rule. At startup and periodically, for any batch not confirmed:

- Scan the payout account's outgoing mainnet transactions since `batch.created_at` for a multi-out whose **total and exact recipient set** match.
- **Found** → adopt the `tx_id`, mark `confirmed`.
- **Not found and `deadline_at` has passed** → the transaction can no longer be mined. Mark `failed` and release its accruals (`batch_id = NULL`) for the next run.
- **Not found and deadline not yet passed** → wait. Do not guess.

The short deadline is what converts *"did it go through?"* from unanswerable into a question that time answers.

### Safety rails

Hard ceilings checked at compose time, which the code cannot exceed:

| Rail | Guards against |
|---|---|
| `MAX_PER_RECIPIENT_PER_BATCH_PLANCK` | A policy bug |
| `MAX_PER_BATCH_PLANCK` | An aggregation bug |
| `MAX_PER_WALLCLOCK_DAY_PLANCK` | A *loop* bug — the one caps alone miss |
| `MIN_WALLET_BALANCE_PLANCK` | Running the float dry unnoticed |
| Balance drift check | Actual wallet balance vs. ledger expectation; divergence beyond tolerance trips |

`MAX_PER_WALLCLOCK_DAY_PLANCK` is deliberately wall-clock, unlike the chain-day accrual budget. They guard different things: chain-day governs *what miners are owed*, wall-clock governs *how fast the wallet can drain*. During a large catch-up they differ, and that is correct — a backlog is paid over multiple batches rather than in one burst.

Tripping the kill-switch halts all payouts and fires every channel. **Clearing it is manual, from the admin UI.**

Accrual and indexing continue while payouts are halted: miners still earn, only delivery pauses. A trip is therefore never destructive, which is what allows the rails to be aggressive rather than timid.

---

## 5. Health monitoring

Two transports answering different questions:

| Source | Interval | Feeds |
|---|---|---|
| SIP-50 `HEARTBEAT` | ~30s | Are we alive? |
| SIP-50 `BLOCK_PUSHED` | on block | Is the chain moving? |
| SIP-50 `CONNECTED` | on (re)connect | `localHeight` vs `globalHeight`, sync state |
| REST `getPeers` | 60s | Peer count |
| REST testnet `getBlockchainStatus` | fallback | Chain progress when WS is down |
| REST mainnet `getAccount` | 5 min | Payout wallet balance |

WebSocket endpoint per SIP-50: `ws[s]://<host>:<port>/events`, default HTTP API port + 1, configurable via `API.WebsocketPort`. The spec limits it to reading public blockchain information — no transactions are ever generated over it, which matches its role here.

### State machine

```
WS heartbeats OK                          → primary path
heartbeat missing, HTTP polls OK          → ws_degraded (warn) — chain status still known
heartbeat missing, blocks not advancing   → testnet_stalled (CRITICAL)
heartbeat missing, HTTP also failing      → node_unreachable (CRITICAL) — our side
local height < global height by > N       → node_out_of_sync (warn)
```

Falling back to the HTTP API when the heartbeat stops is what keeps `testnet_stalled` detectable with a dead socket, instead of collapsing into "unknown". `ws_degraded` is deliberately **not** escalated to "testnet stuck" — conflating the two is the false alarm that trains an operator to ignore alerts.

### Alerts

`testnet_stalled`, `ws_degraded`, `node_unreachable`, `node_out_of_sync`, `low_peers`, `wallet_low`, `mainnet_unreachable`, `payout_failing`, `kill_switch_tripped`, `publisher_stale`.

An alert opens only after its condition holds for N consecutive checks and closes after it clears for M. Recovery notifies too — a "resolved" message is worth as much as the alarm.

### Notifier

One `Channel` interface; each channel activates only if its env config is present. Telegram (bot token + chat id), Discord (webhook URL) and email (**Resend**, free tier) are all plain `fetch` calls — no SMTP connections to babysit on a Pi. Severity routing is config: critical to all channels, warning to Telegram and Discord.

Accepted limitation: if the Pi loses internet, no outbound channel works. Alerts queue locally and fire on reconnect; the status page's staleness rule covers the case where the Pi is unreachable entirely.

---

## 6. User interfaces

### Public status page — Next.js on Vercel, reading Turso

Server components query Turso with a **read-only token**, revalidating every ~30s.

- **Status banner** — overall health in plain language, not colour alone
- **Testnet vitals** — height, time since last block, average block time, peers, sync state
- **Rewards overview** — total distributed, last 24h / 7d, current rate per block, today's remaining budget, next payout ETA
- **Leaderboard** — blocks mined and rewards earned per miner, pending accrual shown separately from paid
- **Recent payouts** — confirmed batches with explorer links to the mainnet transaction
- **"Why am I not earning?"** — address lookup returning eligibility status and skip reasons
- **Health history** — sparkline from downsampled samples

The address lookup is the highest-leverage feature: every skip reason is already recorded, so it costs one query and answers the question that would otherwise arrive as a direct message.

**The staleness rule.** Every view derives from `status.updated_at`. If that timestamp is older than `STALENESS_THRESHOLD_SECONDS`, the page stops presenting numbers as current and states that the service is not reporting. Without this, a dead Pi produces a page that looks perfectly healthy — the worst failure mode a status page can have, because it is silent.

### Local admin UI — `Bun.serve` on the LAN

Built with Bun's HTML imports (React, no build config), deliberately utilitarian.

- **Views** — ledger state, unbatched accruals, batch queue and history, open alerts, live health
- **Controls** — pause/resume payouts, flush now, clear kill-switch, exclude/include a miner, force a mainnet account re-check
- **Dry-run a batch** — compose a batch and show exactly what *would* be sent, without broadcasting. Nearly free, since compose is already a pure step separated from broadcast, and it is the single most valuable check before the first real payout.
- **Auth** — bound to the LAN interface plus a shared token from env.

Both UIs consume **the same projection function**. The publisher pushes its output to Turso; the admin serves it directly. One place to change when a new stat is wanted.

---

## 7. Deployment

### Repo layout

```
src/            service (Pi) — ledger, indexer, eligibility, policy,
                               payout, health, publisher, notifier, admin
web/            Next.js status page (Vercel: Root Directory = web)
tests/
config/         ecosystem.config.cjs, .env.example, turso schema
scripts/        backup, rebuild, one-off ops
docs/
```

The Pi never builds or serves `web/`; Vercel never sees `src/`. The only coupling is the Turso read-model schema in `config/`.

### pm2

```js
// config/ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "signum-testnet-rewards",
    script: "src/main.ts",
    interpreter: "/home/pi/.bun/bin/bun",   // absolute — pm2's PATH is not the shell's
    instances: 1,                            // invariant, not a tuning knob
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 10,
    max_memory_restart: "400M",
  }],
};
```

`instances: 1` is load-bearing: two instances would mean two SQLite writers and two batches in flight, breaking the single-batch invariant that reconciliation depends on. pm2 cluster mode does not apply to Bun. This must be commented in the file.

Then `pm2 save` and `pm2 startup` for boot persistence, plus `pm2-logrotate`.

### Storage on the attached HDD

The data directory (`rewards.sqlite`, `chainwalker.cache.json`, logs) lives on the attached HDD rather than the SD card, avoiding SD wear. Space needed is modest: at Signum's ~4 minute target block time, ~360 blocks/day means `block_rewards` grows ~131k rows/year, well under 100 MB/year with indexes. Health samples are pruned to a rolling window; logs are capped by rotation. A couple of GB covers several years.

**Mount safety is the most important operational hazard in the design.** USB enumeration on a Pi is not guaranteed to finish before pm2 starts the service. If the service boots while the HDD is unmounted, SQLite silently creates a fresh empty database at that path, the walker cache is missing, and every historical block is re-accrued into an empty ledger — a full re-payout of the entire history, running until the rails trip. The idempotency guards cannot help: they protect against duplicate rows, not against a missing table to check against.

Two mitigations:

1. **Mount sentinel.** A file `<data-dir>/.volume-ok`, written once at setup, is checked during boot-time config validation **before** SQLite is opened. Missing → refuse to start, alert, let pm2 retry with backoff. A file that exists only on the real volume cannot be satisfied by an empty mountpoint directory.
2. **Co-locate the two caches.** `rewards.sqlite` and `chainwalker.cache.json` always live on the same volume. Split across volumes they can desynchronise in the dangerous direction — walker cache ahead on SD, ledger gone on unmounted HDD — which silently *skips* blocks. Together they fail together, which the sentinel then catches.

Plus `nofail` in `/etc/fstab` so a missing drive does not block boot.

Other Pi realities: clock sync (chrony/ntp) is required, since transaction deadlines and `chain_day` bucketing both depend on it. Nightly `VACUUM INTO` a dated copy on a second volume.

**Reconstructibility.** The system can be rebuilt from the two chains: accruals by re-walking testnet from the start height, payment history by scanning the payout account's outgoing mainnet transactions. `scripts/rebuild.ts` makes this concrete. Backups remain cheaper, but a corrupted database is a bad day rather than a catastrophe.

### Configuration

All money-related settings are **required with no defaults**, validated against a schema at boot. Invalid or missing config **refuses to start** — a service that silently falls back to a default payout amount is worse than one that will not boot. The volume sentinel check is part of the same validation.

Example `config/.env.example` values (operator must set real ones):

```
# Money settings are declared in SIGNA, not planck. All are REQUIRED with no
# defaults: the service refuses to start rather than pay a guessed amount.
# Agreed parameters: ~900 SIGNA/day at Signum's ~360 blocks/day.
REWARD_PER_BLOCK_SIGNA=2.5
ACCOUNT_DAILY_CAP_SIGNA=100
GLOBAL_DAILY_BUDGET_SIGNA=1000
MIN_PAYOUT_SIGNA=5
MAX_PER_RECIPIENT_PER_BATCH_SIGNA=200
MAX_PER_BATCH_SIGNA=2000
MAX_PER_WALLCLOCK_DAY_SIGNA=3000
MIN_WALLET_BALANCE_SIGNA=5000
MAX_FEE_SIGNA=1

# --- chain ---
TESTNET_NODE_HOST=http://localhost:6876
TESTNET_WS_URL=ws://localhost:6877/events
MAINNET_NODE_HOSTS=CHANGE_ME_NODE_1,CHANGE_ME_NODE_2
START_HEIGHT=0
BLOCK_OFFSET=2
WALKER_INTERVAL_SECONDS=5

# --- payouts (Phase 2; keep false during shadow mode) ---
PAYOUTS_ENABLED=false
PAYOUT_INTERVAL_MINUTES=360
TX_DEADLINE_MINUTES=30
CONFIRMATIONS_REQUIRED=3
# PAYOUT_ACCOUNT_SEED must NEVER be committed. chmod 600 the real .env.
PAYOUT_ACCOUNT_SEED=

# --- health ---
STALL_THRESHOLD_MINUTES=15
MIN_PEERS=3
SYNC_LAG_BLOCKS=5
ALERT_OPEN_AFTER_CHECKS=3
ALERT_CLOSE_AFTER_CHECKS=3

# --- publishing: optional. Leave both blank to run without Turso. ---
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
PUBLISH_INTERVAL_SECONDS=30
STALENESS_THRESHOLD_SECONDS=180
MAINNET_ACCOUNT_TTL_POSITIVE_SECONDS=86400
MAINNET_ACCOUNT_TTL_NEGATIVE_SECONDS=3600

# --- storage: must be on the HDD, and the sentinel must exist ---
DATA_DIR=/mnt/hdd/signum-rewards

# --- notifications: each channel activates only if fully configured ---
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
RESEND_API_KEY=
ALERT_EMAIL_TO=

# --- admin: bind to the LAN interface, NOT 0.0.0.0 ---
ADMIN_BIND_HOST=192.168.1.50
ADMIN_PORT=3100
ADMIN_TOKEN=
```

The seed lives only in `.env` (gitignored, `chmod 600`), never in config files, logs, the admin UI, or anything published to Turso.

---

## 8. Testing

`bun test` throughout. Attention is proportional to risk.

- **`policy`** — pure, therefore exhaustive: cap boundaries, chain-day edges, dust rollover, budget exhaustion mid-day.
- **`ledger`** — `:memory:` SQLite. The two properties that matter: replaying a block twice yields one accrual; an accrual can never land in two batches.
- **`indexer`** — chain-walker ships a `MockLedger`, so blocks can be fed deterministically without a node. Covers catch-up and replay.
- **`payout`** — mocked mainnet client, driving the state machine through crash scenarios explicitly: die after compose, die after broadcast, deadline expiry with no matching transaction, reconciliation finding a match, and the single-recipient fallback.
- **`eligibility`** — mocked lookups including the public-key mismatch path.
- **`health`** — fake clock and synthetic WS events; assert each tier, especially that a dead socket with a live HTTP poll does *not* raise `testnet_stalled` while blocks advance.
- **Integration** — MockLedger testnet plus fake mainnet, block through to confirmed batch.

## 9. Rollout

1. **Shadow mode** — `PAYOUTS_ENABLED=false` against live testnet for a week. Accruals accumulate, dry-run shows what would be sent, nothing leaves the wallet. Accruals verified against the chain by hand.
2. **Small float** — tiny reward per block, low caps, small balance on the payout account.
3. **Full operation** — after several real batches confirm cleanly.

## 10. Operator inputs required before go-live

These are values the operator supplies, not unresolved design questions. The design is complete without them; the service refuses to start until they are set.

| Input | Needed by | Notes |
|---|---|---|
| Reward per block and all cap/rail values | ~~End of shadow mode~~ **Settled**: 2.5 SIGNA/block, 100/account/day, 1000/day global | Derived from a ~900 SIGNA/day target at ~360 blocks/day, so the global budget is a backstop rather than a mid-day cliff |
| `START_HEIGHT` | First launch | Defines the beginning of the reward programme |
| Mainnet node host list | First launch | Two or more public nodes for failover |
| Payout account seed and initial float | Stage 2 of rollout | Small float first |
| Notification channel credentials | First launch | Any subset; each channel activates only if configured |
| `payout_recipients` retention window | After real volume is observed | Default ~90 days |
