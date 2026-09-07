import type { Ledger } from "../ledger/db.ts";
import type { AppConfig } from "../config/schema.ts";
import type { WsMonitor } from "./wsMonitor.ts";
import type { ProbeResult } from "./httpProbe.ts";
import type { HeadBlock } from "../chain/testnetClient.ts";
import type { HealthAssessment, ForkObservation } from "./healthState.ts";
import { assessHealth } from "./healthState.ts";
import type { ForkMonitor } from "./forkMonitor.ts";
import { emptyCounters, applyHysteresis } from "./hysteresis.ts";
import type { HysteresisCounters } from "./hysteresis.ts";
import { openAlert, resolveAlert, listOpenAlerts, recordNotice } from "../ledger/alerts.ts";
import { recordHealthSample } from "../ledger/healthSamples.ts";
import {
  tripKillSwitch,
  clearKillSwitch,
  isKillSwitchTripped,
  recordChainHalt,
  getChainHalt,
  getReorgAuditHeight,
} from "../ledger/state.ts";
import { decideHaltRelease, HALT_INCIDENTS } from "./chainHalt.ts";
import { silentLogger } from "../log.ts";
import type { Logger } from "../log.ts";

export interface HealthMonitorDeps {
  db: Ledger;
  config: AppConfig;
  wsMonitor: WsMonitor;
  probe: () => Promise<ProbeResult>;
  intervalMs: number;
  /** Absent when no reference nodes are configured; fork state is then always unknown. */
  forkMonitor?: ForkMonitor;
  now?: () => number;
  log?: Logger;
}

/**
 * The head block as of the last successful probe.
 *
 * `observedAtMs` is carried so a consumer can tell a current head from one left
 * over by a node that has since stopped answering — the same reason the fork
 * state carries its own timestamp.
 */
export interface ChainHead {
  block: HeadBlock;
  observedAtMs: number;
}

export interface HealthMonitor {
  start: () => void;
  stop: () => void;
  getLatest: () => HealthAssessment | undefined;
  /** Undefined until a probe has described the head block at least once. */
  getChainHead: () => ChainHead | undefined;
  /** Runs one cycle immediately. Exposed for the admin UI and for tests. */
  tick: () => Promise<HealthAssessment>;
}

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? silentLogger();
  let counters: HysteresisCounters = emptyCounters();
  let latest: HealthAssessment | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastBlockAtMs: number | undefined;
  let chainHead: ChainHead | undefined;

  async function tick(): Promise<HealthAssessment> {
    const probeResult = await deps.probe();
    const wsState = deps.wsMonitor.getState();

    // Either transport observing a new block counts as block progress.
    if (wsState.lastBlockAtMs !== undefined) {
      lastBlockAtMs = Math.max(lastBlockAtMs ?? 0, wsState.lastBlockAtMs);
    }
    if (probeResult.blockAdvancedAtMs !== undefined) {
      lastBlockAtMs = Math.max(lastBlockAtMs ?? 0, probeResult.blockAdvancedAtMs);
    }

    // Kept from the last probe that described it: a probe failure should blank
    // the head no more than it blanks the height, and the timestamp says how old
    // the answer is.
    if (probeResult.head) chainHead = { block: probeResult.head, observedAtMs: now() };

    // Read, never awaited: the fork monitor runs on its own slower timer, so the
    // health loop consumes whatever its last completed round concluded.
    const forkState = deps.forkMonitor?.getState();
    const fork: ForkObservation | undefined = forkState && {
      verdict: forkState.comparison.verdict,
      confirmed: forkState.confirmed,
      message: forkState.comparison.message,
      observedAtMs: forkState.observedAtMs,
    };

    const assessment = assessHealth(
      {
        nowMs: now(),
        lastHeartbeatAtMs: wsState.lastHeartbeatAtMs,
        lastBlockAtMs,
        httpReachable: probeResult.httpReachable,
        localHeight: probeResult.localHeight ?? wsState.localHeight,
        globalHeight: probeResult.globalHeight ?? wsState.globalHeight,
        peerCount: probeResult.peerCount,
        fork,
      },
      {
        heartbeatTimeoutMs: 90_000,
        stallThresholdMs: deps.config.health.stallThresholdMinutes * 60_000,
        syncLagBlocks: deps.config.health.syncLagBlocks,
        minPeers: deps.config.health.minPeers,
        forkStateMaxAgeMs: deps.config.health.forkCheckIntervalSeconds * 3_000,
      },
    );

    latest = assessment;

    const openKinds = new Set(listOpenAlerts(deps.db).map((a) => a.kind));
    const decision = applyHysteresis(counters, assessment.conditions, openKinds, {
      openAfterChecks: deps.config.health.alertOpenAfterChecks,
      closeAfterChecks: deps.config.health.alertCloseAfterChecks,
    });
    counters = decision.counters;

    for (const condition of decision.toOpen) {
      openAlert(deps.db, {
        kind: condition.kind,
        severity: condition.severity,
        message: condition.message,
      });
      // A confirmed fork means our accruals may sit on a chain that is about to
      // disappear. Halting here rather than in the payout path keeps the decision
      // at the moment of evidence, and the kill switch has no automatic reset:
      // resolving the alert must not silently release the money.
      if (condition.kind === "chain_fork") {
        tripKillSwitch(deps.db, condition.message);
        // Remembered because the halt outlives the fork. Releasing it later is a
        // question about the blocks at and above this height, and by then the
        // verdict that named it will be long gone.
        if (forkState?.comparison.height !== undefined) {
          recordChainHalt(deps.db, { height: forkState.comparison.height, cause: "fork" });
        }
      }
    }
    for (const kind of decision.toResolve) {
      resolveAlert(deps.db, kind);
    }

    releaseChainHaltIfEarned(fork);

    recordHealthSample(deps.db, {
      sampledAt: Math.floor(now() / 1000),
      localHeight: probeResult.localHeight ?? null,
      globalHeight: probeResult.globalHeight ?? null,
      inSync: assessment.conditions.every((c) => c.kind !== "node_out_of_sync"),
      peerCount: probeResult.peerCount ?? null,
      secondsSinceLastBlock:
        lastBlockAtMs === undefined ? null : Math.floor((now() - lastBlockAtMs) / 1000),
      status: assessment.overall,
    });

    return assessment;
  }

  /**
   * Lifts a chain halt once the evidence says it is safe to.
   *
   * The kill switch still has no blanket automatic reset — a rail violation or
   * a paid-out orphan keeps needing a human. What it now has is one specific
   * exit: the chain event it was tripped by is over AND the reorg audit has
   * since verified every block back to where it happened. Without that second
   * half a self-healing chain would either strand the service until someone
   * noticed, or resume paying on accruals nobody ever re-checked.
   */
  function releaseChainHaltIfEarned(fork: ForkObservation | undefined): void {
    const halt = getChainHalt(deps.db);
    if (halt === undefined) return;

    const openKinds = listOpenAlerts(deps.db).map((a) => a.kind);
    const outcome = decideHaltRelease({
      nowMs: now(),
      killSwitchTripped: isKillSwitchTripped(deps.db),
      halt,
      fork,
      forkStateMaxAgeMs: deps.config.health.forkCheckIntervalSeconds * 3_000,
      forkAlertOpen: openKinds.includes("chain_fork"),
      auditedHeight: getReorgAuditHeight(deps.db),
      paidOrphanOutstanding: openKinds.includes("reorg_paid_accrual"),
    });

    if (outcome.kind === "hold") {
      log.debug("chain halt stays in place", { reason: outcome.reason });
      return;
    }

    // Clears the remembered halt with it.
    clearKillSwitch(deps.db);
    // The incident this halt was about is genuinely over — the audit said so.
    // A paid-orphan incident can never reach here; the release rule holds while
    // one is open, and only a human closes that.
    resolveAlert(deps.db, "chain_rewound");
    log.warn("chain halt released automatically", { height: halt.height, cause: halt.cause });
    // Critical because it is the exact counterpart of the critical alert that
    // stopped the money: whoever was told payouts halted has to be told, on the
    // same channel, that they are moving again.
    recordNotice(deps.db, {
      kind: "chain_halt_released",
      severity: "critical",
      message: outcome.message,
    });
  }

  return {
    start() {
      deps.wsMonitor.start();
      void tick();
      timer = setInterval(() => void tick(), deps.intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      deps.wsMonitor.stop();
    },
    getLatest: () => latest,
    getChainHead: () => chainHead,
    tick,
  };
}
