import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createClient } from "@libsql/client";
import type { Client, Row } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTursoPublisher } from "../../src/publish/tursoPublisher.ts";
import type { Publisher, PublisherConfig } from "../../src/publish/tursoPublisher.ts";
import { PUBLISH_SCHEMA_SQL, parseSchemaColumns } from "../../src/publish/tursoSchema.ts";
import type { Projection } from "../../src/publish/projection.ts";

// A file-backed libsql database speaks the same SQL as Turso, so the bootstrap
// and the upserts are exercised for real rather than against a mock that would
// happily accept a column the remote does not have.
let dir: string;
let url: string;
let publisher: Publisher;
let clockMs: number;

const HEARTBEAT = 60;
const FULL_SYNC = 3_600;
const RETENTION = 30 * 86_400;

const makePublisher = (over: Partial<PublisherConfig> = {}): Publisher =>
  createTursoPublisher({
    url,
    authToken: "",
    heartbeatSeconds: HEARTBEAT,
    fullSyncSeconds: FULL_SYNC,
    retentionSeconds: RETENTION,
    now: () => clockMs,
    ...over,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turso-test-"));
  url = `file:${join(dir, "publish.db")}`;
  clockMs = 1_800_000_000_000;
  publisher = makePublisher();
});

afterEach(() => {
  publisher.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Reads run on a FRESH connection every time.
 *
 * A libsql connection caches the schema its statements were prepared against,
 * so a long-lived reader can still report the pre-ALTER columns after the
 * publisher has reconciled them — an artefact of holding the connection open,
 * not of the publish. Reconnecting is also what a real consumer does.
 */
async function withReader<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = createClient({ url, authToken: "" });
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

const rows = (sql: string): Promise<Row[]> =>
  withReader(async (c) => (await c.execute(sql)).rows);

const exec = (sql: string): Promise<void> =>
  withReader(async (c) => {
    await c.executeMultiple(sql);
  });

const projection = (over: Partial<Projection> = {}): Projection => ({
  status: {
    updatedAt: 1_800_000_000,
    payoutsEnabled: true,
    payoutsPaused: false,
    killSwitch: false,
    budgetRemainingPlanck: 100_000_000,
    spentTodayPlanck: 150_000_000,
    totalDistributedPlanck: 250_000_000,
    pendingPlanck: 750_000_000,
    minerCount: 1,
    nextPayoutAt: 1_800_021_600,
    payoutBlockedBy: null,
    payoutDue: false,
    lastPayoutAt: 1_799_996_400,
    openAlerts: [],
  },
  miners: [
    {
      accountId: "acct-1", accountRS: "TS-ACCT-0001", mainnetAccount: "active", blocksMined: 3, blocksSkipped: 1,
      pendingPlanck: 750_000_000, paidPlanck: 250_000_000,
      lastBlockAt: 500_000, lastSkipReason: "skipped_no_mainnet_account",
    },
  ],
  payouts: [
    { batchId: 7, txId: "tx-7", confirmedAt: 1_799_999_000, recipientCount: 2, totalPlanck: 500_000_000 },
  ],
  ...over,
});

const tableNames = async (): Promise<string[]> =>
  (await rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"))
    .map((r) => String(r.name));

const statusRow = async (): Promise<Row> => (await rows("SELECT * FROM status"))[0]!;

describe("turso schema bootstrap", () => {
  test("init creates the read-model tables on an empty database", async () => {
    expect(await tableNames()).not.toContain("miners");

    await publisher.init();

    expect(await tableNames()).toEqual(["miners", "payouts", "status"]);
  });

  test("init is idempotent against an already-bootstrapped database", async () => {
    await publisher.init();
    const second = makePublisher();
    await second.init();
    second.close();

    expect(await tableNames()).toEqual(["miners", "payouts", "status"]);
  });

  test("BOOTSTRAP IS NOT REQUIRED AT BOOT: publish creates the tables itself", async () => {
    await publisher.publish(projection());

    expect((await statusRow()).total_distributed_planck).toBe(250_000_000);
  });

  test("existing rows survive a re-bootstrap", async () => {
    await publisher.publish(projection());
    await publisher.init();

    expect(await rows("SELECT account_id FROM miners")).toHaveLength(1);
  });
});

describe("parseSchemaColumns", () => {
  test("recovers every declared column so the reconciler cannot drift", () => {
    const tables = parseSchemaColumns(PUBLISH_SCHEMA_SQL);
    expect([...tables.keys()].sort()).toEqual(["miners", "payouts", "status"]);
    expect(tables.get("payouts")!.map((c) => c.name)).toEqual([
      "batch_id", "tx_id", "confirmed_at", "recipient_count", "total_planck",
    ]);
  });

  test("splits the name from a definition an ALTER TABLE can use verbatim", () => {
    const status = parseSchemaColumns(PUBLISH_SCHEMA_SQL).get("status")!;
    expect(status.find((c) => c.name === "pending_planck")!.definition)
      .toBe("INTEGER NOT NULL DEFAULT 0");
  });

  test("skips table-level constraints", () => {
    const tables = parseSchemaColumns(
      "CREATE TABLE IF NOT EXISTS t (\n  a INTEGER,\n  b TEXT,\n  PRIMARY KEY (a, b)\n);",
    );
    expect(tables.get("t")!.map((c) => c.name)).toEqual(["a", "b"]);
  });
});

describe("a remote created by an older build", () => {
  // The published shape grows over time. CREATE TABLE IF NOT EXISTS does nothing
  // to a table that already exists, so without reconciliation the first push of
  // a new field would fail on every tick, forever, against a live database.
  const legacyStatus = `
    CREATE TABLE status (
      id                       INTEGER PRIMARY KEY,
      updated_at               INTEGER NOT NULL,
      service_status           TEXT    NOT NULL,
      payouts_enabled          INTEGER NOT NULL DEFAULT 0,
      payouts_paused           INTEGER NOT NULL DEFAULT 0,
      kill_switch              INTEGER NOT NULL DEFAULT 0,
      budget_remaining_planck  INTEGER NOT NULL DEFAULT 0,
      total_distributed_planck INTEGER NOT NULL DEFAULT 0,
      open_alerts              TEXT    NOT NULL DEFAULT '[]'
    );`;

  test("GAINS THE MISSING COLUMNS INSTEAD OF FAILING EVERY PUSH", async () => {
    await exec(legacyStatus);
    await exec("INSERT INTO status (id, updated_at, service_status) VALUES (1, 1, 'ok');");

    await publisher.publish(projection());

    const row = await statusRow();
    expect(row.next_payout_at).toBe(1_800_021_600);
    expect(row.pending_planck).toBe(750_000_000);
    expect(row.payout_due).toBe(0);
  });

  test("keeps rows written before the columns existed", async () => {
    await exec(legacyStatus);
    await exec(`INSERT INTO status (id, updated_at, service_status, total_distributed_planck)
                VALUES (1, 42, 'ok', 999);`);

    await publisher.init();

    const row = await statusRow();
    expect(row.total_distributed_planck).toBe(999);
    expect(row.next_payout_at).toBeNull();
  });
});

describe("publish", () => {
  test("writes status, miners and payouts", async () => {
    await publisher.publish(projection());

    const status = await statusRow();
    expect(status.id).toBe(1);
    expect(status.service_status).toBe("ok");
    expect(status.kill_switch).toBe(0);
    expect(status.open_alerts).toBe("[]");

    const miner = (await rows("SELECT * FROM miners"))[0]!;
    expect(miner.account_id).toBe("acct-1");
    expect(miner.account_rs).toBe("TS-ACCT-0001");
    expect(miner.mainnet_account).toBe("active");
    expect(miner.pending_planck).toBe(750_000_000);
    expect(miner.last_skip_reason).toBe("skipped_no_mainnet_account");

    const payout = (await rows("SELECT * FROM payouts"))[0]!;
    expect(payout.batch_id).toBe(7);
    expect(payout.tx_id).toBe("tx-7");
  });

  // Zero would be published as an exhausted allowance; the column has to be able
  // to hold "no ceiling" as a value distinct from that.
  test("publishes what the day has spent next to what is left", async () => {
    await publisher.publish(projection());

    expect((await statusRow()).spent_today_planck).toBe(150_000_000);
  });

  test("publishes an unconfigured budget as NULL, not as zero", async () => {
    const next = projection();
    next.status.budgetRemainingPlanck = null;

    await publisher.publish(next);

    expect((await statusRow()).budget_remaining_planck).toBeNull();
  });

  test("republishing upserts rather than duplicating", async () => {
    await publisher.publish(projection());

    const next = projection();
    next.status.openAlerts = ["node_stalled"];
    next.miners[0]!.pendingPlanck = 900_000_000;
    await publisher.publish(next);

    const status = await rows("SELECT * FROM status");
    expect(status).toHaveLength(1);
    expect(status[0]!.service_status).toBe("degraded");

    const miners = await rows("SELECT * FROM miners");
    expect(miners).toHaveLength(1);
    expect(miners[0]!.pending_planck).toBe(900_000_000);
  });

  test("a nullable payout keeps its nulls", async () => {
    await publisher.publish(
      projection({
        payouts: [{ batchId: 8, txId: null, confirmedAt: null, recipientCount: null, totalPlanck: null }],
      }),
    );

    const payout = (await rows("SELECT * FROM payouts"))[0]!;
    expect(payout.tx_id).toBeNull();
    expect(payout.total_planck).toBeNull();
  });
});

describe("the published payout schedule", () => {
  test("carries the next payout, what is owed, and the real enabled flag", async () => {
    await publisher.publish(projection());

    const row = await statusRow();
    expect(row.payouts_enabled).toBe(1);
    expect(row.pending_planck).toBe(750_000_000);
    expect(row.next_payout_at).toBe(1_800_021_600);
    expect(row.last_payout_at).toBe(1_799_996_400);
    expect(row.payout_blocked_by).toBeNull();
  });

  test("A BLOCKED PAYOUT PUBLISHES THE REASON AND NO TIME", async () => {
    const blocked = projection();
    blocked.status.payoutsEnabled = false;
    blocked.status.nextPayoutAt = null;
    blocked.status.payoutBlockedBy = "disabled";
    await publisher.publish(blocked);

    const row = await statusRow();
    expect(row.payouts_enabled).toBe(0);
    expect(row.next_payout_at).toBeNull();
    expect(row.payout_blocked_by).toBe("disabled");
  });

  test("an overdue payout is published as due", async () => {
    const overdue = projection();
    overdue.status.payoutDue = true;
    await publisher.publish(overdue);

    expect((await statusRow()).payout_due).toBe(1);
  });
});

describe("turso I/O", () => {
  // Republishing everything every tick cost a row read and a row write per miner
  // per interval, whether or not anything had happened. These are the tests that
  // hold that cost down.
  test("A SECOND PUBLISH OF UNCHANGED STATE TOUCHES THE DATABASE AT ALL", async () => {
    await publisher.publish(projection());

    clockMs += 30_000;
    const outcome = await publisher.publish(projection());

    expect(outcome.skipped).toBe(true);
    expect(outcome.statusWritten).toBe(false);
    expect(outcome.minersWritten).toBe(0);
    expect(outcome.payoutsWritten).toBe(0);
  });

  test("a miner activating their mainnet account is republished", async () => {
    const first = projection();
    first.miners[0]!.mainnetAccount = "inactive";
    await publisher.publish(first);

    clockMs += 30_000;
    const next = projection();
    next.miners[0]!.mainnetAccount = "active";
    const outcome = await publisher.publish(next);

    expect(outcome.minersWritten).toBe(1);
    expect((await rows("SELECT mainnet_account FROM miners"))[0]!.mainnet_account).toBe("active");
  });

  test("only the changed miner is sent", async () => {
    const first = projection();
    first.miners.push({
      accountId: "acct-2", accountRS: "TS-ACCT-0002", mainnetAccount: "inactive", blocksMined: 1, blocksSkipped: 0,
      pendingPlanck: 250_000_000, paidPlanck: 0,
      lastBlockAt: 500_001, lastSkipReason: null,
    });
    await publisher.publish(first);

    clockMs += 30_000;
    const next = structuredClone(first);
    next.miners[1]!.pendingPlanck = 500_000_000;
    const outcome = await publisher.publish(next);

    expect(outcome.minersWritten).toBe(1);
    expect(outcome.payoutsWritten).toBe(0);

    // The unchanged row must still be intact, and the changed one updated.
    const rows_ = await rows("SELECT account_id, pending_planck FROM miners ORDER BY account_id");
    expect(rows_.map((r) => Number(r.pending_planck))).toEqual([750_000_000, 500_000_000]);
  });

  test("the heartbeat refreshes updated_at without rewriting the miners", async () => {
    await publisher.publish(projection());

    clockMs += HEARTBEAT * 1_000;
    const fresh = projection();
    fresh.status.updatedAt = 1_800_000_060;
    const outcome = await publisher.publish(fresh);

    expect(outcome.statusWritten).toBe(true);
    expect(outcome.minersWritten).toBe(0);
    expect(outcome.fullSync).toBe(false);
    expect((await statusRow()).updated_at).toBe(1_800_000_060);
  });

  test("the periodic full sync repairs a remote that was truncated behind our back", async () => {
    await publisher.publish(projection());
    await exec("DELETE FROM miners;");

    clockMs += FULL_SYNC * 1_000;
    const outcome = await publisher.publish(projection());

    expect(outcome.fullSync).toBe(true);
    expect(await rows("SELECT account_id FROM miners")).toHaveLength(1);
  });

  test("A FAILED PUBLISH IS NOT REMEMBERED AS PUBLISHED", async () => {
    // `extra` is NOT NULL with no default, and the publisher never supplies it,
    // so the whole batch is rejected. Reconciliation cannot rescue this: it only
    // ADDS the columns the publisher expects.
    await exec("CREATE TABLE miners (account_id TEXT PRIMARY KEY, extra TEXT NOT NULL);");
    await expect(publisher.publish(projection())).rejects.toThrow();
    expect(await tableNames()).toContain("miners");

    await exec(`DROP TABLE miners;
                CREATE TABLE miners (
                  account_id TEXT PRIMARY KEY, blocks_mined INTEGER, blocks_skipped INTEGER,
                  pending_planck INTEGER, paid_planck INTEGER, last_block_at INTEGER,
                  last_skip_reason TEXT
                );`);

    clockMs += 30_000;
    const outcome = await publisher.publish(projection());

    expect(outcome.minersWritten).toBe(1);
    expect(outcome.statusWritten).toBe(true);
    expect(await rows("SELECT account_id FROM miners")).toHaveLength(1);
  });

  test("a fresh process republishes everything, having no memory of the remote", async () => {
    await publisher.publish(projection());

    clockMs += 30_000;
    const restarted = makePublisher();
    const outcome = await restarted.publish(projection());
    restarted.close();

    expect(outcome.fullSync).toBe(true);
    expect(outcome.minersWritten).toBe(1);
  });
});

describe("published payout retention", () => {
  // `payouts` is the only remote table that grows with time: `status` is one row
  // and `miners` is bounded by how many accounts have ever forged.
  const nowSeconds = () => Math.floor(clockMs / 1000);

  test("A PAYOUT PAST THE WINDOW IS DROPPED FROM THE REMOTE", async () => {
    await publisher.publish(projection());
    await exec(`INSERT INTO payouts (batch_id, tx_id, confirmed_at, recipient_count, total_planck)
                VALUES (1, 'tx-1', ${nowSeconds() - RETENTION - 1}, 1, 100);`);

    clockMs += FULL_SYNC * 1_000;
    const outcome = await publisher.publish(projection());

    expect(outcome.payoutsDeleted).toBe(1);
    expect((await rows("SELECT batch_id FROM payouts")).map((r) => Number(r.batch_id))).toEqual([7]);
  });

  test("a payout inside the window is kept", async () => {
    await publisher.publish(projection());
    await exec(`INSERT INTO payouts (batch_id, tx_id, confirmed_at, recipient_count, total_planck)
                VALUES (1, 'tx-1', ${nowSeconds() - 86_400}, 1, 100);`);

    clockMs += FULL_SYNC * 1_000;
    expect((await publisher.publish(projection())).payoutsDeleted).toBe(0);
    expect(await rows("SELECT batch_id FROM payouts")).toHaveLength(2);
  });

  test("an unconfirmed payout has no age yet and is never dropped", async () => {
    await publisher.publish(projection());
    await exec(`INSERT INTO payouts (batch_id, tx_id, confirmed_at, recipient_count, total_planck)
                VALUES (1, 'tx-1', NULL, 1, 100);`);

    clockMs += FULL_SYNC * 1_000;
    await publisher.publish(projection());

    expect(await rows("SELECT batch_id FROM payouts WHERE confirmed_at IS NULL")).toHaveLength(1);
  });

  test("an idle, fully paid miner is dropped from the remote", async () => {
    await publisher.publish(projection());
    await exec(`INSERT INTO miners (account_id, account_rs, pending_planck, paid_planck, last_block_at)
                VALUES ('idle', 'TS-IDLE', 0, 500, ${nowSeconds() - RETENTION - 1});`);

    clockMs += FULL_SYNC * 1_000;
    const outcome = await publisher.publish(projection());

    expect(outcome.minersDeleted).toBe(1);
    expect((await rows("SELECT account_id FROM miners")).map((r) => r.account_id))
      .toEqual(["acct-1"]);
  });

  test("A MINER STILL OWED MONEY IS NEVER DROPPED, HOWEVER IDLE", async () => {
    await publisher.publish(projection());
    await exec(`INSERT INTO miners (account_id, account_rs, pending_planck, paid_planck, last_block_at)
                VALUES ('owed', 'TS-OWED', 42, 0, ${nowSeconds() - RETENTION - 1});`);

    clockMs += FULL_SYNC * 1_000;
    const outcome = await publisher.publish(projection());

    expect(outcome.minersDeleted).toBe(0);
    expect(await rows("SELECT account_id FROM miners")).toHaveLength(2);
  });

  test("the status row carries the miner count for a one-row page read", async () => {
    await publisher.publish(projection());
    expect((await statusRow()).miner_count).toBe(1);
  });

  test("RETENTION COSTS NOTHING BETWEEN FULL SYNCS", async () => {
    await publisher.publish(projection());
    await exec(`INSERT INTO payouts (batch_id, tx_id, confirmed_at, recipient_count, total_planck)
                VALUES (1, 'tx-1', ${nowSeconds() - RETENTION - 1}, 1, 100);`);

    clockMs += HEARTBEAT * 1_000;
    const outcome = await publisher.publish(projection());

    expect(outcome.fullSync).toBe(false);
    expect(outcome.payoutsDeleted).toBe(0);
    expect(outcome.minersDeleted).toBe(0);
    expect(await rows("SELECT batch_id FROM payouts")).toHaveLength(2);
  });
});
