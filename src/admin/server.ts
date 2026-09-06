import type { Amount } from "@signumjs/util";
import { ChainTime } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { RailsConfig } from "../domain/rails.ts";
import type { HealthAssessment } from "../health/healthState.ts";
import type { ForkState } from "../health/forkMonitor.ts";
import type { ChainHead } from "../health/monitor.ts";
import { lastIndexedBlock } from "../ledger/blockRewards.ts";
import { toReedSolomon } from "../domain/address.ts";
import { buildProjection } from "../publish/projection.ts";
import type { PayoutScheduleOptions } from "../publish/projection.ts";
import { dryRunBatch } from "../payout/dryRun.ts";
import type { DryRunReport } from "../payout/dryRun.ts";
import { toChainDay } from "../domain/chainDay.ts";
import { listOpenAlerts } from "../ledger/alerts.ts";
import { setPayoutsPaused, clearKillSwitch, getKillSwitchReason } from "../ledger/state.ts";
import { sumBroadcastSinceWallClock } from "../ledger/batches.ts";
import index from "./index.html";

export interface AdminServerDeps {
  db: Ledger;
  token: string;
  host: string;
  port: number;
  minPayout: Amount;
  rails: RailsConfig;
  globalDailyBudget: Amount;
  payoutSchedule: PayoutScheduleOptions;
  getHealth: () => HealthAssessment | undefined;
  getChainHead: () => ChainHead | undefined;
  /** Absent when fork detection is disabled. */
  getForkState?: () => ForkState | undefined;
}

export interface AdminServer {
  url: string;
  stop: () => void;
}

/**
 * Length-independent comparison so the token cannot be probed by timing.
 * Compares over a fixed number of iterations regardless of input length.
 */
function tokensMatch(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Amounts become planck strings so the response is plain JSON. */
function serialiseDryRun(report: DryRunReport) {
  return {
    wouldSend: report.wouldSend,
    requiresOrdinarySend: report.requiresOrdinarySend,
    railsVerdict: report.railsVerdict,
    totalPlanck: report.draft.total.getPlanck(),
    recipients: report.draft.recipients.map((r) => ({
      recipientId: r.recipientId,
      planck: r.amount.getPlanck(),
    })),
    deferredDust: report.deferredDust.map((d) => d.recipientId),
    deferredOverflow: report.deferredOverflow.map((d) => d.recipientId),
  };
}

/**
 * Fork state is reported even when it is "agreed", so the operator can see that
 * the check is running. A blank panel is indistinguishable from a broken one.
 */
function serialiseFork(state: ForkState | undefined) {
  if (!state) return null;
  return {
    verdict: state.comparison.verdict,
    confirmed: state.confirmed,
    height: state.comparison.height,
    // The compared block itself, not just the verdict about it: on a fork these
    // two values are the evidence, and an operator comparing them against a
    // block explorer needs to see exactly what our node claimed.
    blockId: state.comparison.local?.blockId ?? null,
    generationSignature: state.comparison.local?.generationSignature ?? null,
    message: state.comparison.message,
    observedAt: Math.floor(state.observedAtMs / 1000),
    agreeing: state.comparison.agreeingHosts,
    disagreeing: state.comparison.disagreeingHosts,
    abstaining: state.comparison.abstainingHosts,
  };
}

/**
 * The node's head block beside the highest block we have processed.
 *
 * Both are reported because they answer different questions: the head says what
 * the chain is doing, the indexed height says whether this service is keeping up
 * with it. Showing only one hides a stuck indexer behind a healthy node.
 */
function serialiseChain(db: Ledger, head: ChainHead | undefined) {
  const indexed = lastIndexedBlock(db);
  return {
    head: head && {
      height: head.block.height,
      blockId: head.block.blockId,
      generationSignature: head.block.generationSignature,
      generatorId: head.block.generatorId,
      generatorRS: head.block.generatorRS,
      forgedAt: head.block.forgedAt,
      observedAt: Math.floor(head.observedAtMs / 1000),
    },
    indexed: indexed && {
      height: indexed.height,
      blockId: indexed.blockId,
      generatorId: indexed.generatorId,
      generatorRS: toReedSolomon(indexed.generatorId),
    },
    /** Blocks the indexer trails the node by, or null while either is unknown. */
    blocksBehind: head && indexed ? head.block.height - indexed.height : null,
  };
}

export function createAdminServer(deps: AdminServerDeps): AdminServer {
  const startOfWallClockDay = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };

  const currentDryRun = () =>
    dryRunBatch(deps.db, {
      minPayout: deps.minPayout,
      rails: deps.rails,
      spentToday: sumBroadcastSinceWallClock(deps.db, startOfWallClockDay()),
    });

  const authorised = (req: Request, url: URL): boolean => {
    const supplied = req.headers.get("x-admin-token") ?? url.searchParams.get("token") ?? "";
    return tokensMatch(supplied, deps.token);
  };

  const api = (handler: (req: Request, url: URL) => Response | Promise<Response>) =>
    async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (!authorised(req, url)) return json({ error: "unauthorized" }, 401);
      return handler(req, url);
    };

  const postOnly = (handler: () => Response) =>
    api((req) => (req.method === "POST" ? handler() : json({ error: "method not allowed" }, 405)));

  const server = Bun.serve({
    hostname: deps.host,
    port: deps.port,
    // HTML import: Bun bundles app.tsx and theme.css referenced by index.html.
    // Serving the file directly with Bun.file would ship an unbundled <script>.
    routes: {
      "/": index,
      "/api/state": api(() =>
        json({
          projection: buildProjection(deps.db, {
            nowEpochSeconds: Math.floor(Date.now() / 1000),
            chainDay: toChainDay(ChainTime.fromDate(new Date()).getChainTimestamp()),
            recentPayoutLimit: 20,
            payouts: deps.payoutSchedule,
            globalDailyBudget: deps.globalDailyBudget,
          }),
          health: deps.getHealth() ?? null,
          chain: serialiseChain(deps.db, deps.getChainHead()),
          fork: serialiseFork(deps.getForkState?.()),
          openAlerts: listOpenAlerts(deps.db),
          killSwitchReason: getKillSwitchReason(deps.db) ?? null,
          dryRun: serialiseDryRun(currentDryRun()),
        }),
      ),
      "/api/dry-run": api(() => json(serialiseDryRun(currentDryRun()))),
      "/api/pause": postOnly(() => {
        setPayoutsPaused(deps.db, true);
        return json({ ok: true, paused: true });
      }),
      "/api/resume": postOnly(() => {
        setPayoutsPaused(deps.db, false);
        return json({ ok: true, paused: false });
      }),
      "/api/kill-switch/clear": postOnly(() => {
        clearKillSwitch(deps.db);
        return json({ ok: true });
      }),
    },
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        if (!authorised(req, url)) return json({ error: "unauthorized" }, 401);
        return json({ error: "not found" }, 404);
      }
      return json({ error: "not found" }, 404);
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
  };
}
