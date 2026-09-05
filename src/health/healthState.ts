import type { Severity } from "../ledger/alerts.ts";

export type HealthAlertKind =
  | "node_unreachable"
  | "testnet_stalled"
  | "ws_degraded"
  | "node_out_of_sync"
  | "low_peers";

export interface HealthInputs {
  nowMs: number;
  /** Last SIP-50 HEARTBEAT. undefined means we have never had one. */
  lastHeartbeatAtMs: number | undefined;
  /** Last observed new block, from either WS BLOCK_PUSHED or an HTTP height increase. */
  lastBlockAtMs: number | undefined;
  /** Whether the most recent HTTP probe of the testnet node succeeded. */
  httpReachable: boolean;
  localHeight: number | undefined;
  globalHeight: number | undefined;
  peerCount: number | undefined;
}

export interface HealthThresholds {
  heartbeatTimeoutMs: number;
  stallThresholdMs: number;
  syncLagBlocks: number;
  minPeers: number;
}

export interface HealthCondition {
  kind: HealthAlertKind;
  severity: Severity;
  message: string;
}

export interface HealthAssessment {
  overall: "ok" | "warning" | "critical";
  conditions: HealthCondition[];
  wsAlive: boolean;
}

/**
 * Turns raw observations into a set of active conditions.
 *
 * The design rule: never infer a chain problem from an observer problem. A dead
 * WebSocket alone is `ws_degraded`, a warning, because the HTTP fallback still
 * tells us whether blocks are advancing. Only when BOTH transports are silent do
 * we say the node is unreachable, and `testnet_stalled` is raised strictly from
 * block timing, whichever transport supplied it.
 *
 * Unknown inputs raise nothing. On a cold start we have not seen a block yet,
 * and treating that as a stall would fire a critical alert on every restart.
 */
export function assessHealth(
  inputs: HealthInputs,
  thresholds: HealthThresholds,
): HealthAssessment {
  const conditions: HealthCondition[] = [];

  const wsAlive =
    inputs.lastHeartbeatAtMs !== undefined &&
    inputs.nowMs - inputs.lastHeartbeatAtMs <= thresholds.heartbeatTimeoutMs;

  if (!wsAlive && !inputs.httpReachable) {
    conditions.push({
      kind: "node_unreachable",
      severity: "critical",
      message: "Testnet node is unreachable over both WebSocket and HTTP",
    });
  } else if (!wsAlive) {
    conditions.push({
      kind: "ws_degraded",
      severity: "warning",
      message: "SIP-50 heartbeat lost; falling back to HTTP polling. Chain status still known.",
    });
  }

  if (inputs.lastBlockAtMs !== undefined) {
    const sinceBlockMs = inputs.nowMs - inputs.lastBlockAtMs;
    if (sinceBlockMs > thresholds.stallThresholdMs) {
      conditions.push({
        kind: "testnet_stalled",
        severity: "critical",
        message: `No new block for ${Math.floor(sinceBlockMs / 60_000)} minutes`,
      });
    }
  }

  if (inputs.localHeight !== undefined && inputs.globalHeight !== undefined) {
    const lag = inputs.globalHeight - inputs.localHeight;
    if (lag > thresholds.syncLagBlocks) {
      conditions.push({
        kind: "node_out_of_sync",
        severity: "warning",
        message: `Local node is ${lag} blocks behind the network`,
      });
    }
  }

  if (inputs.peerCount !== undefined && inputs.peerCount < thresholds.minPeers) {
    conditions.push({
      kind: "low_peers",
      severity: "warning",
      message: `Only ${inputs.peerCount} peers connected (minimum ${thresholds.minPeers})`,
    });
  }

  const overall = conditions.some((c) => c.severity === "critical")
    ? "critical"
    : conditions.length > 0
      ? "warning"
      : "ok";

  return { overall, conditions, wsAlive };
}
