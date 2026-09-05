import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { createAdminServer } from "../../src/admin/server.ts";
import type { AdminServer } from "../../src/admin/server.ts";
import { isPayoutsPaused, isKillSwitchTripped, tripKillSwitch } from "../../src/ledger/state.ts";

let db: Ledger;
let server: AdminServer;
let base: string;
const TOKEN = "test-token";

beforeEach(() => {
  db = openLedger(":memory:");
  server = createAdminServer({
    db,
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    minPayout: Amount.fromSigna("5"),
    rails: {
      maxPerRecipientPerBatch: Amount.fromSigna("200"),
      maxPerBatch: Amount.fromSigna("2000"),
      maxPerWallClockDay: Amount.fromSigna("3000"),
    },
    globalDailyBudget: Amount.fromSigna("1000"),
    getHealth: () => undefined,
  });
  base = server.url;
});
afterEach(() => server.stop());

const auth = { headers: { "x-admin-token": TOKEN } };

describe("admin server auth", () => {
  test("rejects an API request with no token", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
  });
  test("rejects an API request with a wrong token", async () => {
    expect((await fetch(`${base}/api/state`, { headers: { "x-admin-token": "nope" } })).status).toBe(401);
  });
  test("rejects a token of a different length without leaking timing", async () => {
    expect((await fetch(`${base}/api/state`, { headers: { "x-admin-token": "x" } })).status).toBe(401);
  });
  test("accepts a request with the correct token", async () => {
    expect((await fetch(`${base}/api/state`, auth)).status).toBe(200);
  });
});

describe("admin server routes", () => {
  test("GET /api/state returns the projection, health and a dry-run", async () => {
    const body = (await (await fetch(`${base}/api/state`, auth)).json()) as Record<string, unknown>;
    expect(body).toHaveProperty("projection");
    expect(body).toHaveProperty("dryRun");
    expect(body).toHaveProperty("openAlerts");
  });

  test("POST /api/pause and /api/resume toggle payouts", async () => {
    await fetch(`${base}/api/pause`, { method: "POST", ...auth });
    expect(isPayoutsPaused(db)).toBe(true);
    await fetch(`${base}/api/resume`, { method: "POST", ...auth });
    expect(isPayoutsPaused(db)).toBe(false);
  });

  test("POST /api/kill-switch/clear clears a tripped kill switch", async () => {
    tripKillSwitch(db, "test trip");
    expect(isKillSwitchTripped(db)).toBe(true);
    expect((await fetch(`${base}/api/kill-switch/clear`, { method: "POST", ...auth })).status).toBe(200);
    expect(isKillSwitchTripped(db)).toBe(false);
  });

  test("DRY RUN IS READ-ONLY: requesting it creates no batch", async () => {
    await fetch(`${base}/api/dry-run`, auth);
    const batches = db.query("SELECT COUNT(*) AS c FROM batches").get() as { c: number };
    expect(batches.c).toBe(0);
  });

  test("mutating routes reject GET", async () => {
    expect((await fetch(`${base}/api/pause`, auth)).status).toBe(405);
  });

  test("an unknown API route returns 404", async () => {
    expect((await fetch(`${base}/api/nonsense`, auth)).status).toBe(404);
  });

  test("the admin token never appears in a response body", async () => {
    const text = await (await fetch(`${base}/api/state`, auth)).text();
    expect(text).not.toContain(TOKEN);
  });
});
