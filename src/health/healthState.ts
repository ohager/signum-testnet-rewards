import type { Severity } from "../ledger/alerts.ts";
import type { ForkVerdict } from "./forkCheck.ts";

export type HealthAlertKind =
  | "node_unreachable"
  | "testnet_stalled"
  | "ws_degraded"
  | "node_out_of_sync"
  | "low_peers"
  | "chain_fork"
  | "reference_nodes_disagree";

/**
 * The health loop's view of the fork monitor's latest round.
 *
 * `confirmed` and `observedAtMs` are carried deliberately: this loop ticks far
 * more often than fork checks run, so it must be able to tell a fresh, repeated
 * verdict from a single stale one it happens to be looking at again.
 */
/**
 * The alert kinds this module raises, and therefore the only ones it may close.
 *
 * Stated as a value, not just a type, because the hysteresis loop has to decide
 * at runtime whether an open alert is one of its own. Everything else in the
 * alerts table belongs to whoever raised it: the payout runner's failures, the
 * reorg auditor's paid-orphan incident. Closing those on the strength of "the
 * chain looks fine to me" is how a halt that needed a human lifted itself in
 * three minutes.
 */
export const HEALTH_ALERT_KINDS: readonly HealthAlertKind[] = [
  "node_unreachable",
  "testnet_stalled",
  "ws_degraded",
  "node_out_of_sync",
  "low_peers",
  "chain_fork",
  "reference_nodes_disagree",
];

export function isHealthAlertKind(kind: string): kind is HealthAlertKind {
  return (HEALTH_ALERT_KINDS as readonly string[]).includes(kind);
}

export interface ForkObservation {
  verdict: ForkVerdict;
  confirmed: boolean;
  message: string;
  observedAtMs: number;
}

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
  /** undefined when fork detection is disabled or has not completed a round yet. */
  fork: ForkObservation | undefined;
}

export interface HealthThresholds {
  heartbeatTimeoutMs: number;
  stallThresholdMs: number;
  syncLagBlocks: number;
  minPeers: number;
  /** Beyond this age a fork verdict is treated as unknown rather than current. */
  forkStateMaxAgeMs: number;
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

  // A fork verdict acts only while it is both confirmed and current. A stale
  // one means the fork monitor has stopped reporting, which is an observer
  // problem, and the same rule applies to it as to a dead socket: it raises
  // nothing about the chain.
  const fork = inputs.fork;
  if (
    fork &&
    fork.confirmed &&
    inputs.nowMs - fork.observedAtMs <= thresholds.forkStateMaxAgeMs
  ) {
    if (fork.verdict === "forked") {
      conditions.push({ kind: "chain_fork", severity: "critical", message: fork.message });
    } else if (fork.verdict === "references_disagree") {
      conditions.push({
        kind: "reference_nodes_disagree",
        severity: "warning",
        message: fork.message,
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
