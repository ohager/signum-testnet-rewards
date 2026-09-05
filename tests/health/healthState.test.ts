import { test, expect, describe } from "bun:test";
import { assessHealth } from "../../src/health/healthState.ts";
import type { HealthInputs, HealthThresholds } from "../../src/health/healthState.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const thresholds: HealthThresholds = {
  heartbeatTimeoutMs: 90_000,
  stallThresholdMs: 15 * MIN,
  syncLagBlocks: 5,
  minPeers: 3,
};

const healthy: HealthInputs = {
  nowMs: NOW,
  lastHeartbeatAtMs: NOW - 10_000,
  lastBlockAtMs: NOW - 2 * MIN,
  httpReachable: true,
  localHeight: 1000,
  globalHeight: 1000,
  peerCount: 8,
};

const kinds = (i: HealthInputs) => assessHealth(i, thresholds).conditions.map((c) => c.kind);

describe("assessHealth", () => {
  test("reports ok when everything is healthy", () => {
    const result = assessHealth(healthy, thresholds);
    expect(result.overall).toBe("ok");
    expect(result.conditions).toHaveLength(0);
  });

  test("CRITICAL: heartbeat gone and HTTP unreachable means our side is broken", () => {
    const result = assessHealth(
      { ...healthy, lastHeartbeatAtMs: NOW - 5 * MIN, httpReachable: false }, thresholds);
    expect(result.overall).toBe("critical");
    expect(result.conditions.map((c) => c.kind)).toContain("node_unreachable");
  });

  test("CRITICAL: no blocks past the stall threshold means the testnet is stuck", () => {
    const result = assessHealth({ ...healthy, lastBlockAtMs: NOW - 20 * MIN }, thresholds);
    expect(result.overall).toBe("critical");
    expect(result.conditions.map((c) => c.kind)).toContain("testnet_stalled");
  });

  test("THE KEY CASE: dead socket but HTTP fine and blocks advancing is only a warning", () => {
    const result = assessHealth(
      { ...healthy, lastHeartbeatAtMs: NOW - 5 * MIN, httpReachable: true }, thresholds);
    expect(result.overall).toBe("warning");
    expect(result.conditions.map((c) => c.kind)).toContain("ws_degraded");
    expect(result.conditions.map((c) => c.kind)).not.toContain("testnet_stalled");
  });

  test("a dead socket does not suppress a genuine stall detected over HTTP", () => {
    const result = assessHealth({
      ...healthy, lastHeartbeatAtMs: NOW - 5 * MIN, httpReachable: true,
      lastBlockAtMs: NOW - 20 * MIN,
    }, thresholds);
    expect(result.conditions.map((c) => c.kind)).toContain("testnet_stalled");
    expect(result.overall).toBe("critical");
  });

  test("warns when the local node lags the network", () => {
    expect(kinds({ ...healthy, localHeight: 990, globalHeight: 1000 })).toContain("node_out_of_sync");
  });

  test("does not warn for a lag within tolerance", () => {
    expect(kinds({ ...healthy, localHeight: 997, globalHeight: 1000 })).not.toContain("node_out_of_sync");
  });

  test("warns on low peer count", () => {
    expect(kinds({ ...healthy, peerCount: 1 })).toContain("low_peers");
  });

  test("STARTUP: unknown block time is not treated as a stall", () => {
    const result = assessHealth({ ...healthy, lastBlockAtMs: undefined }, thresholds);
    expect(result.conditions.map((c) => c.kind)).not.toContain("testnet_stalled");
  });

  test("STARTUP: unknown heights and peer count raise nothing", () => {
    const result = assessHealth({
      nowMs: NOW, lastHeartbeatAtMs: NOW - 1000, lastBlockAtMs: undefined,
      httpReachable: true, localHeight: undefined, globalHeight: undefined, peerCount: undefined,
    }, thresholds);
    expect(result.overall).toBe("ok");
  });

  test("reports several simultaneous conditions, escalating to the worst", () => {
    const result = assessHealth({ ...healthy, peerCount: 1, lastBlockAtMs: NOW - 20 * MIN }, thresholds);
    expect(result.conditions.map((c) => c.kind).sort()).toEqual(["low_peers", "testnet_stalled"]);
    expect(result.overall).toBe("critical");
  });
});
