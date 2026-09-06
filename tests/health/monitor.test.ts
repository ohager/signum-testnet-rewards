import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { createHealthMonitor } from "../../src/health/monitor.ts";
import { listOpenAlerts } from "../../src/ledger/alerts.ts";
import { initialWsState } from "../../src/health/wsEvents.ts";
import type { WsState } from "../../src/health/wsEvents.ts";
import type { ProbeResult } from "../../src/health/httpProbe.ts";
import type { AppConfig } from "../../src/config/schema.ts";
import type { ForkMonitor, ForkState } from "../../src/health/forkMonitor.ts";
import { isKillSwitchTripped, getKillSwitchReason } from "../../src/ledger/state.ts";

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
    forkCheckIntervalSeconds: 300,
    forkCheckDepth: 10,
  },
} as AppConfig;

const monitorWith = (
  wsState: WsState,
  probeResult: ProbeResult,
  forkMonitor?: ForkMonitor,
  now = () => NOW,
) =>
  createHealthMonitor({
    db,
    config,
    wsMonitor: { start: () => {}, stop: () => {}, getState: () => wsState },
    probe: async () => probeResult,
    intervalMs: 1000,
    forkMonitor,
    now,
  });

/** A fork monitor frozen on one already-completed round. */
const stubForkMonitor = (state: ForkState): ForkMonitor => ({
  start: () => {},
  stop: () => {},
  getState: () => state,
  check: async () => state,
});

const forkState = (
  verdict: "agreed" | "forked" | "references_disagree" | "unknown",
  confirmed: boolean,
): ForkState => ({
  comparison: {
    verdict,
    height: 990,
    local: { blockId: "111", generationSignature: "aaaa" },
    agreeingHosts: [],
    disagreeingHosts: ["a"],
    abstainingHosts: [],
    message: `verdict ${verdict}`,
  },
  streak: confirmed ? 3 : 1,
  confirmed,
  observedAtMs: NOW,
});

const healthyProbe: ProbeResult = {
  httpReachable: true, localHeight: 1000, globalHeight: 1000, head: undefined,
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

  test("THE MONEY CASE: a confirmed fork opens chain_fork and trips the kill switch", async () => {
    const monitor = monitorWith(
      { ...initialWsState(), lastHeartbeatAtMs: NOW },
      healthyProbe,
      stubForkMonitor(forkState("forked", true)),
    );
    for (let i = 0; i < 3; i++) await monitor.tick();
    expect(listOpenAlerts(db).map((a) => a.kind)).toContain("chain_fork");
    expect(isKillSwitchTripped(db)).toBe(true);
    expect(getKillSwitchReason(db)).toContain("forked");
  });

  test("the kill switch stays tripped and is not re-tripped on later ticks", async () => {
    const monitor = monitorWith(
      { ...initialWsState(), lastHeartbeatAtMs: NOW },
      healthyProbe,
      stubForkMonitor(forkState("forked", true)),
    );
    for (let i = 0; i < 8; i++) await monitor.tick();
    expect(listOpenAlerts(db).filter((a) => a.kind === "chain_fork")).toHaveLength(1);
  });

  test("references disagreeing warns but never touches the money", async () => {
    const monitor = monitorWith(
      { ...initialWsState(), lastHeartbeatAtMs: NOW },
      healthyProbe,
      stubForkMonitor(forkState("references_disagree", true)),
    );
    for (let i = 0; i < 4; i++) await monitor.tick();
    expect(listOpenAlerts(db).map((a) => a.kind)).toContain("reference_nodes_disagree");
    expect(isKillSwitchTripped(db)).toBe(false);
  });

  test("an unconfirmed fork raises nothing however many health ticks pass", async () => {
    const monitor = monitorWith(
      { ...initialWsState(), lastHeartbeatAtMs: NOW },
      healthyProbe,
      stubForkMonitor(forkState("forked", false)),
    );
    for (let i = 0; i < 8; i++) await monitor.tick();
    expect(listOpenAlerts(db)).toHaveLength(0);
    expect(isKillSwitchTripped(db)).toBe(false);
  });

  test("no fork monitor configured leaves the assessment healthy", async () => {
    const monitor = monitorWith({ ...initialWsState(), lastHeartbeatAtMs: NOW }, healthyProbe);
    for (let i = 0; i < 4; i++) await monitor.tick();
    expect(monitor.getLatest()?.overall).toBe("ok");
    expect(isKillSwitchTripped(db)).toBe(false);
  });
});

describe("chain head retention", () => {
  const head = {
    height: 980_544,
    blockId: "433423838390268815",
    generationSignature: "1e9a4139925",
    generatorId: "4325295135044374377",
    generatorRS: "TS-R5VB-2B6J-2N8C-5BN3S",
    forgedAt: 1_700_000_000,
  };

  test("is undefined until a probe has described the head", async () => {
    const monitor = monitorWith({ ...initialWsState(), lastHeartbeatAtMs: NOW }, healthyProbe);
    await monitor.tick();
    expect(monitor.getChainHead()).toBeUndefined();
  });

  test("carries the forger and the moment it was observed", async () => {
    const monitor = monitorWith(
      { ...initialWsState(), lastHeartbeatAtMs: NOW },
      { ...healthyProbe, head },
    );
    await monitor.tick();

    const chainHead = monitor.getChainHead();
    expect(chainHead?.block.generatorRS).toBe("TS-R5VB-2B6J-2N8C-5BN3S");
    expect(chainHead?.observedAtMs).toBe(NOW);
  });

  test("A FAILED PROBE LEAVES THE LAST KNOWN HEAD IN PLACE", async () => {
    let current: ProbeResult = { ...healthyProbe, head };
    const monitor = createHealthMonitor({
      db,
      config,
      wsMonitor: {
        start: () => {},
        stop: () => {},
        getState: () => ({ ...initialWsState(), lastHeartbeatAtMs: NOW }),
      },
      probe: async () => current,
      intervalMs: 60_000,
      now: () => NOW,
    });

    await monitor.tick();
    current = {
      httpReachable: false, localHeight: undefined, globalHeight: undefined,
      peerCount: undefined, head: undefined, blockAdvancedAtMs: undefined,
    };
    await monitor.tick();

    expect(monitor.getChainHead()?.block.height).toBe(980_544);
  });
});
