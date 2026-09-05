import type { Ledger } from "../ledger/db.ts";
import type { AppConfig } from "../config/schema.ts";
import type { WsMonitor } from "./wsMonitor.ts";
import type { ProbeResult } from "./httpProbe.ts";
import type { HealthAssessment } from "./healthState.ts";
import { assessHealth } from "./healthState.ts";
import { emptyCounters, applyHysteresis } from "./hysteresis.ts";
import type { HysteresisCounters } from "./hysteresis.ts";
import { openAlert, resolveAlert, listOpenAlerts } from "../ledger/alerts.ts";
import { recordHealthSample } from "../ledger/healthSamples.ts";

export interface HealthMonitorDeps {
  db: Ledger;
  config: AppConfig;
  wsMonitor: WsMonitor;
  probe: () => Promise<ProbeResult>;
  intervalMs: number;
  now?: () => number;
}

export interface HealthMonitor {
  start: () => void;
  stop: () => void;
  getLatest: () => HealthAssessment | undefined;
  /** Runs one cycle immediately. Exposed for the admin UI and for tests. */
  tick: () => Promise<HealthAssessment>;
}

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const now = deps.now ?? Date.now;
  let counters: HysteresisCounters = emptyCounters();
  let latest: HealthAssessment | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastBlockAtMs: number | undefined;

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

    const assessment = assessHealth(
      {
        nowMs: now(),
        lastHeartbeatAtMs: wsState.lastHeartbeatAtMs,
        lastBlockAtMs,
        httpReachable: probeResult.httpReachable,
        localHeight: probeResult.localHeight ?? wsState.localHeight,
        globalHeight: probeResult.globalHeight ?? wsState.globalHeight,
        peerCount: probeResult.peerCount,
      },
      {
        heartbeatTimeoutMs: 90_000,
        stallThresholdMs: deps.config.health.stallThresholdMinutes * 60_000,
        syncLagBlocks: deps.config.health.syncLagBlocks,
        minPeers: deps.config.health.minPeers,
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
    }
    for (const kind of decision.toResolve) {
      resolveAlert(deps.db, kind);
    }

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
    tick,
  };
}
