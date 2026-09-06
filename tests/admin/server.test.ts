import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { createAdminServer } from "../../src/admin/server.ts";
import type { ChainHead } from "../../src/health/monitor.ts";
import type { Channel } from "../../src/notify/channel.ts";
import type { PayoutSimulation } from "../../src/payout/simulate.ts";
import { isChannelEnabled } from "../../src/ledger/channelState.ts";
import type { AdminServer } from "../../src/admin/server.ts";
import { isPayoutsPaused, isKillSwitchTripped, tripKillSwitch } from "../../src/ledger/state.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import type { MinerRow } from "../../src/publish/projection.ts";

let db: Ledger;
let server: AdminServer;
let base: string;
let chainHead: ChainHead | undefined;
let testChannels: Channel[];
let sent: string[];
let sendFails: boolean;
let simulationResult: PayoutSimulation;
const TOKEN = "test-token";

beforeEach(() => {
  db = openLedger(":memory:");
  sent = [];
  sendFails = false;
  testChannels = [
    {
      name: "email", minSeverity: "critical",
      send: async () => {
        if (sendFails) throw new Error("Resend responded 403");
        sent.push("email");
      },
    },
    { name: "discord", minSeverity: "warning", send: async () => { sent.push("discord"); } },
  ];
  simulationResult = {
    built: true, recipientCount: 2, totalPlanck: "500000000", feePlanck: "1000000",
    requiresOrdinarySend: false, railsVerdict: { ok: true },
    transaction: {
      signatureHash: "hash", unsignedTransactionBytes: "deadbeef",
      transactionJSON: { type: 0, subtype: 1 },
    },
  };
  chainHead = {
    block: {
      height: 980_544,
      blockId: "433423838390268815",
      generationSignature: "1e9a41399251cc310c8f0f9a626ae09618efdaebaa7013f99ca97a7b4175d217",
      generatorId: "4325295135044374377",
      generatorRS: "TS-R5VB-2B6J-2N8C-5BN3S",
      forgedAt: 1_800_000_000,
    },
    observedAtMs: 1_800_000_500_000,
  };
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
    payoutSchedule: { enabled: false, intervalSeconds: 6 * 3_600, serviceStartedAt: 1_800_000_000 },
    getHealth: () => undefined,
    getChainHead: () => chainHead,
    channels: testChannels,
    simulate: async () => simulationResult,
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

  test("GET /api/state carries what each miner is owed and the next payout", async () => {
    recordBlockReward(db, {
      blockId: "b1", height: 1, blockTimestamp: 500_000, chainDay: "2026-03-14",
      generatorId: "4325295135044374377", generatorPublicKey: "pk-1",
      status: "accrued", amount: Amount.fromSigna("2.5"),
    });

    const body = (await (await fetch(`${base}/api/state`, auth)).json()) as {
      projection: {
        status: { pendingPlanck: number; nextPayoutAt: number | null; payoutBlockedBy: string | null };
        miners: MinerRow[];
      };
    };

    expect(body.projection.miners).toEqual([{
      accountId: "4325295135044374377",
      // The whole point: the panel shows an address a person can check.
      accountRS: "TS-R5VB-2B6J-2N8C-5BN3S",
      // No lookup has been cached for this account in the test ledger.
      mainnetAccount: "unknown",
      blocksMined: 1, blocksSkipped: 0,
      pendingPlanck: 250_000_000, paidPlanck: 0,
      // Chain timestamp 500000 as epoch seconds, not chain time.
      lastBlockAt: 1_408_222_400, lastSkipReason: null,
    }]);
    expect(body.projection.status.pendingPlanck).toBe(250_000_000);
    // The fixture runs in shadow mode, so no time may be promised.
    expect(body.projection.status.nextPayoutAt).toBeNull();
    expect(body.projection.status.payoutBlockedBy).toBe("disabled");
  });

  test("GET /api/state reports the head block, its forger, and the indexed height", async () => {
    recordBlockReward(db, {
      blockId: "b-540", height: 980_540, blockTimestamp: 500_000, chainDay: "2026-03-14",
      generatorId: "4325295135044374377", generatorPublicKey: "pk-1",
      status: "accrued", amount: Amount.fromSigna("2.5"),
    });

    const body = (await (await fetch(`${base}/api/state`, auth)).json()) as {
      chain: {
        head: { height: number; generatorRS: string; generationSignature: string } | null;
        indexed: { height: number; blockId: string; generatorId: string; generatorRS: string } | null;
        blocksBehind: number | null;
      };
    };

    expect(body.chain.head!.height).toBe(980_544);
    expect(body.chain.head!.generatorRS).toBe("TS-R5VB-2B6J-2N8C-5BN3S");
    expect(body.chain.head!.generationSignature).toHaveLength(64);
    expect(body.chain.indexed).toEqual({
      height: 980_540, blockId: "b-540",
      generatorId: "4325295135044374377", generatorRS: "TS-R5VB-2B6J-2N8C-5BN3S",
    });
    expect(body.chain.blocksBehind).toBe(4);
  });

  test("an unanswering node leaves the head null without hiding the indexed height", async () => {
    chainHead = undefined;
    recordBlockReward(db, {
      blockId: "b-540", height: 980_540, blockTimestamp: 500_000, chainDay: "2026-03-14",
      generatorId: "4325295135044374377", generatorPublicKey: "pk-1",
      status: "accrued", amount: Amount.fromSigna("2.5"),
    });

    const body = (await (await fetch(`${base}/api/state`, auth)).json()) as {
      chain: { head: unknown; indexed: { height: number } | null; blocksBehind: number | null };
    };

    expect(body.chain.head ?? null).toBeNull();
    expect(body.chain.indexed!.height).toBe(980_540);
    expect(body.chain.blocksBehind).toBeNull();
  });

  test("nothing indexed yet is reported as such, not as zero", async () => {
    const body = (await (await fetch(`${base}/api/state`, auth)).json()) as {
      chain: { indexed: unknown; blocksBehind: number | null };
    };
    expect(body.chain.indexed ?? null).toBeNull();
    expect(body.chain.blocksBehind).toBeNull();
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

  test("GET /api/state lists the channels without leaking their credentials", async () => {
    const body = (await (await fetch(`${base}/api/state`, auth)).json()) as {
      channels: { name: string; minSeverity: string; enabled: boolean }[];
      simulationAvailable: boolean;
    };

    expect(body.channels).toEqual([
      { name: "email", minSeverity: "critical", enabled: true },
      { name: "discord", minSeverity: "warning", enabled: true },
    ]);
    expect(body.simulationAvailable).toBe(true);
    expect(JSON.stringify(body)).not.toContain("resend");
  });

  test("POST /api/notify/test sends through the named channel", async () => {
    const res = await fetch(`${base}/api/notify/test`, {
      ...auth, method: "POST",
      body: JSON.stringify({ channel: "discord" }),
    });

    expect(await res.json()).toEqual({ ok: true, channel: "discord" });
    expect(sent).toEqual(["discord"]);
  });

  test("A FAILING TEST REPORTS THE REASON rather than a 500", async () => {
    sendFails = true;
    const res = await fetch(`${base}/api/notify/test`, {
      ...auth, method: "POST",
      body: JSON.stringify({ channel: "email" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false, channel: "email", error: "Resend responded 403",
    });
  });

  test("A TEST IGNORES THE MUTE SWITCH: that is when you most need it", async () => {
    await fetch(`${base}/api/notify/channel`, {
      ...auth, method: "POST",
      body: JSON.stringify({ channel: "discord", enabled: false }),
    });

    await fetch(`${base}/api/notify/test`, {
      ...auth, method: "POST",
      body: JSON.stringify({ channel: "discord" }),
    });

    expect(isChannelEnabled(db, "discord")).toBe(false);
    expect(sent).toEqual(["discord"]);
  });

  test("POST /api/notify/channel mutes and unmutes, and it persists", async () => {
    await fetch(`${base}/api/notify/channel`, {
      ...auth, method: "POST",
      body: JSON.stringify({ channel: "email", enabled: false }),
    });
    expect(isChannelEnabled(db, "email")).toBe(false);

    await fetch(`${base}/api/notify/channel`, {
      ...auth, method: "POST",
      body: JSON.stringify({ channel: "email", enabled: true }),
    });
    expect(isChannelEnabled(db, "email")).toBe(true);
  });

  test("an unknown channel is a 404, and a bad body a 400", async () => {
    const unknown = await fetch(`${base}/api/notify/test`, {
      ...auth, method: "POST", body: JSON.stringify({ channel: "carrier-pigeon" }),
    });
    expect(unknown.status).toBe(404);

    const malformed = await fetch(`${base}/api/notify/channel`, {
      ...auth, method: "POST", body: "not json",
    });
    expect(malformed.status).toBe(400);

    const notBoolean = await fetch(`${base}/api/notify/channel`, {
      ...auth, method: "POST", body: JSON.stringify({ channel: "email", enabled: "yes" }),
    });
    expect(notBoolean.status).toBe(400);
  });

  test("POST /api/payout/simulate returns the unsigned transaction", async () => {
    const res = await fetch(`${base}/api/payout/simulate`, { ...auth, method: "POST" });
    const body = (await res.json()) as PayoutSimulation;

    expect(body.built).toBe(true);
    expect(body.transaction?.unsignedTransactionBytes).toBe("deadbeef");
  });

  test("GET on the simulate route is refused: it costs a node call", async () => {
    expect((await fetch(`${base}/api/payout/simulate`, auth)).status).toBe(405);
  });

  test("the notification routes need the admin token like everything else", async () => {
    const res = await fetch(`${base}/api/notify/test`, {
      method: "POST", body: JSON.stringify({ channel: "discord" }),
    });
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
  });

  test("A THROWING ROUTE IS A JSON 500, not a leaked stack", async () => {
    // getHealth is called while assembling /api/state; a throw there stands in
    // for any unexpected failure inside a route.
    const broken = createAdminServer({
      db, token: TOKEN, host: "127.0.0.1", port: 0,
      minPayout: Amount.fromSigna("5"),
      rails: {
        maxPerRecipientPerBatch: Amount.fromSigna("200"),
        maxPerBatch: Amount.fromSigna("2000"),
        maxPerWallClockDay: Amount.fromSigna("3000"),
      },
      globalDailyBudget: Amount.fromSigna("1000"),
      payoutSchedule: { enabled: false, intervalSeconds: 6 * 3_600, serviceStartedAt: 1_800_000_000 },
      getHealth: () => { throw new Error("secret internal detail"); },
      getChainHead: () => undefined,
      channels: [],
    });

    const res = await fetch(`${broken.url}/api/state`, auth);
    const text = await res.text();
    broken.stop();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "internal error" });
    expect(text).not.toContain("secret internal detail");
  });

  test("a failing simulation is a 502 carrying the reason, not a crash", async () => {
    const failing = createAdminServer({
      db, token: TOKEN, host: "127.0.0.1", port: 0,
      minPayout: Amount.fromSigna("5"),
      rails: {
        maxPerRecipientPerBatch: Amount.fromSigna("200"),
        maxPerBatch: Amount.fromSigna("2000"),
        maxPerWallClockDay: Amount.fromSigna("3000"),
      },
      globalDailyBudget: Amount.fromSigna("1000"),
      payoutSchedule: { enabled: false, intervalSeconds: 6 * 3_600, serviceStartedAt: 1_800_000_000 },
      getHealth: () => undefined,
      getChainHead: () => undefined,
      channels: [],
      simulate: async () => { throw new Error("node unreachable"); },
    });

    const res = await fetch(`${failing.url}/api/payout/simulate`, { ...auth, method: "POST" });
    const body = (await res.json()) as { built: boolean; error: string };
    failing.stop();

    expect(res.status).toBe(502);
    expect(body).toEqual({ built: false, error: "node unreachable" });
  });

  test("simulation is reported unavailable rather than pretending", async () => {
    const noSim = createAdminServer({
      db, token: TOKEN, host: "127.0.0.1", port: 0,
      minPayout: Amount.fromSigna("5"),
      rails: {
        maxPerRecipientPerBatch: Amount.fromSigna("200"),
        maxPerBatch: Amount.fromSigna("2000"),
        maxPerWallClockDay: Amount.fromSigna("3000"),
      },
      globalDailyBudget: Amount.fromSigna("1000"),
      payoutSchedule: { enabled: false, intervalSeconds: 6 * 3_600, serviceStartedAt: 1_800_000_000 },
      getHealth: () => undefined,
      getChainHead: () => undefined,
      channels: [],
    });

    const res = await fetch(`${noSim.url}/api/payout/simulate`, { ...auth, method: "POST" });
    noSim.stop();

    expect(res.status).toBe(503);
  });
});

describe("admin server payout account", () => {
  const view = {
    accountId: "6502115112683865257",
    accountRS: "S-9K9L-4CB5-88Y5-F5G4Z",
    balancePlanck: "123400000000",
    existsOnChain: true,
    checkedAt: 1_800_000_000,
    error: null,
  };

  const serverWith = (getPayoutAccount?: () => typeof view) =>
    createAdminServer({
      db, token: TOKEN, host: "127.0.0.1", port: 0,
      minPayout: Amount.fromSigna("5"),
      rails: {
        maxPerRecipientPerBatch: Amount.fromSigna("200"),
        maxPerBatch: Amount.fromSigna("2000"),
        maxPerWallClockDay: Amount.fromSigna("3000"),
      },
      globalDailyBudget: Amount.fromSigna("1000"),
      payoutSchedule: { enabled: false, intervalSeconds: 6 * 3_600, serviceStartedAt: 1_800_000_000 },
      getHealth: () => undefined,
      getChainHead: () => undefined,
      channels: [],
      getPayoutAccount,
    });

  test("GET /api/state carries the payout account and its balance", async () => {
    const s = serverWith(() => view);
    const body = (await (await fetch(`${s.url}/api/state`, auth)).json()) as {
      payoutAccount: typeof view;
    };
    s.stop();

    expect(body.payoutAccount).toEqual(view);
  });

  test("reports null rather than omitting the field when no seed is configured", async () => {
    // The panel distinguishes "no payout account" from "the balance has not
    // loaded", so an absent key and a null value must not look the same.
    const s = serverWith(undefined);
    const body = (await (await fetch(`${s.url}/api/state`, auth)).json()) as Record<string, unknown>;
    s.stop();

    expect(body).toHaveProperty("payoutAccount");
    expect(body.payoutAccount).toBeNull();
  });

  test("reads the account once per state request and never awaits it", async () => {
    // A blocking lookup here would hold up the whole panel behind a mainnet
    // node, so the server may only call a function that answers from cache.
    let calls = 0;
    const s = serverWith(() => {
      calls++;
      return view;
    });

    await fetch(`${s.url}/api/state`, auth);
    s.stop();

    expect(calls).toBe(1);
  });
});
