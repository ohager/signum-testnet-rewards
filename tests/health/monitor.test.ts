import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { createHealthMonitor } from "../../src/health/monitor.ts";
import { listOpenAlerts } from "../../src/ledger/alerts.ts";
import { initialWsState } from "../../src/health/wsEvents.ts";
import type { WsState } from "../../src/health/wsEvents.ts";
import type { ProbeResult } from "../../src/health/httpProbe.ts";
import type { AppConfig } from "../../src/config/schema.ts";

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

const NOW = 1_800_000_000_000;

const config = {
  health: {
    stallThresholdMinutes: 15,
    minPeers: 3,
    syncLagBlocks: 5,
    alertOpenAfterChecks: 3,
    alertCloseAfterChecks: 3,
  },
} as AppConfig;

const monitorWith = (wsState: WsState, probeResult: ProbeResult, now = () => NOW) =>
  createHealthMonitor({
    db,
    config,
    wsMonitor: { start: () => {}, stop: () => {}, getState: () => wsState },
    probe: async () => probeResult,
    intervalMs: 1000,
    now,
  });

const healthyProbe: ProbeResult = {
  httpReachable: true, localHeight: 1000, globalHeight: 1000,
  peerCount: 8, blockAdvancedAtMs: undefined,
};

describe("health monitor", () => {
  test("records a health sample on every tick", async () => {
    const monitor = monitorWith({ ...initialWsState(), lastHeartbeatAtMs: NOW }, healthyProbe);
    await monitor.tick();
    await monitor.tick();
    const rows = db.query("SELECT COUNT(*) AS c FROM health_samples").get() as { c: number };
    expect(rows.c).toBe(2);
  });

  test("opens no alert while healthy", async () => {
    const monitor = monitorWith({ ...initialWsState(), lastHeartbeatAtMs: NOW }, healthyProbe);
    for (let i = 0; i < 5; i++) await monitor.tick();
    expect(listOpenAlerts(db)).toHaveLength(0);
  });

  test("HYSTERESIS: a persistent low-peer condition opens exactly one alert", async () => {
    const monitor = monitorWith(
      { ...initialWsState(), lastHeartbeatAtMs: NOW },
      { ...healthyProbe, peerCount: 1 },
    );
    await monitor.tick();
    await monitor.tick();
    expect(listOpenAlerts(db)).toHaveLength(0); // not yet: needs 3 checks
    await monitor.tick();
    const open = listOpenAlerts(db);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("low_peers");
    // Further ticks must not create a second incident.
    for (let i = 0; i < 5; i++) await monitor.tick();
    expect(listOpenAlerts(db)).toHaveLength(1);
  });

  test("FALLBACK: a dead socket with advancing HTTP blocks does not raise testnet_stalled", async () => {
    // ws heartbeat is stale, but the HTTP probe reports a block advancing now.
    const monitor = monitorWith(
      { ...initialWsState(), lastHeartbeatAtMs: NOW - 10 * 60_000 },
      { ...healthyProbe, blockAdvancedAtMs: NOW },
    );
    for (let i = 0; i < 4; i++) await monitor.tick();
    const kinds = listOpenAlerts(db).map((a) => a.kind);
    expect(kinds).toContain("ws_degraded");
    expect(kinds).not.toContain("testnet_stalled");
  });

  test("exposes the latest assessment for the admin UI", async () => {
    const monitor = monitorWith({ ...initialWsState(), lastHeartbeatAtMs: NOW }, healthyProbe);
    expect(monitor.getLatest()).toBeUndefined();
    await monitor.tick();
    expect(monitor.getLatest()?.overall).toBe("ok");
  });
});
