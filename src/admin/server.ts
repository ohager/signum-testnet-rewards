import type { Amount } from "@signumjs/util";
import { ChainTime } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { RailsConfig } from "../domain/rails.ts";
import type { RewardPolicyConfig } from "../domain/policy.ts";
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
import { sumBroadcastSinceWallClock, liveBatch } from "../ledger/batches.ts";
import { isChannelEnabled, setChannelEnabled } from "../ledger/channelState.ts";
import { simulatePayout } from "../payout/simulate.ts";
import type { PayoutSimulation } from "../payout/simulate.ts";
import type { PayoutAccountView } from "../payout/payoutAccount.ts";
import type { PayoutRunner, ReleaseMode, RunOutcome } from "../payout/runner.ts";
import type { Channel } from "../notify/channel.ts";
import { describeError, silentLogger } from "../log.ts";
import type { Logger } from "../log.ts";
import index from "./index.html";

export interface AdminServerDeps {
  db: Ledger;
  token: string;
  host: string;
  port: number;
  minPayout: Amount;
  rails: RailsConfig;
  /** The reward rules in force, shown on the panel and published to the site. */
  policy: RewardPolicyConfig;
  payoutSchedule: PayoutScheduleOptions;
  getHealth: () => HealthAssessment | undefined;
  getChainHead: () => ChainHead | undefined;
  /** Configured channels, for the tester and the mute switches. */
  channels: Channel[];
  log?: Logger;
  /**
   * Turns the current dry run into an unsigned transaction. Takes the report
   * rather than building it, so the panel simulates exactly the batch it is
   * already displaying.
   */
  simulate?: (report: DryRunReport) => Promise<PayoutSimulation>;
  /** Absent when fork detection is disabled. */
  getForkState?: () => ForkState | undefined;
  /**
   * The account payouts are sent FROM, with its mainnet balance.
   *
   * Absent when PAYOUT_ACCOUNT_SEED is unset. Must not block: it is read on
   * every poll of /api/state, so the implementation is expected to answer from
   * cache and refresh out of band.
   */
  getPayoutAccount?: () => PayoutAccountView;
  /**
   * The payout runner. Absent in a deployment with no runner wired, in which
   * case the panel reports releasing as unavailable rather than offering a
   * button that does nothing.
   */
  runner?: PayoutRunner;
  releaseMode?: ReleaseMode;
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

/**
 * The batch the runner still owes work on, or null.
 *
 * Reported even when it is merely waiting, because "a payout is in flight" is
 * the reason the release button is refused, and an operator who cannot see it
 * would read the refusal as a bug.
 */
function serialiseLiveBatch(db: Ledger) {
  const batch = liveBatch(db);
  if (!batch) return null;
  return {
    id: batch.id,
    status: batch.status,
    recipientCount: batch.recipientCount,
    totalPlanck: batch.total ? batch.total.getPlanck() : null,
    txId: batch.txId,
    broadcastHost: batch.broadcastHost,
    broadcastAt: batch.broadcastAt,
    confirmedAt: batch.confirmedAt,
    deadlineAt: batch.deadlineAt,
    attemptCount: batch.attemptCount,
    lastError: batch.lastError,
  };
}

/** Never exposes credentials: a channel is identified by name and nothing else. */
function serialiseChannels(db: Ledger, channels: Channel[]) {
  return channels.map((c) => ({
    name: c.name,
    minSeverity: c.minSeverity,
    enabled: isChannelEnabled(db, c.name),
  }));
}

export function createAdminServer(deps: AdminServerDeps): AdminServer {
  const log = deps.log ?? silentLogger();
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

  /** POST with a JSON body. A malformed body is a 400, never a 500. */
  const postJson = (handler: (body: Record<string, unknown>) => Promise<Response> | Response) =>
    api(async (req) => {
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "expected a JSON body" }, 400);
      }
      return handler(body);
    });

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
            policy: deps.policy,
            minPayout: deps.minPayout,
            chainHead: deps.getChainHead()?.block,
          }),
          health: deps.getHealth() ?? null,
          chain: serialiseChain(deps.db, deps.getChainHead()),
          channels: serialiseChannels(deps.db, deps.channels),
          simulationAvailable: Boolean(deps.simulate),
          fork: serialiseFork(deps.getForkState?.()),
          payoutAccount: deps.getPayoutAccount?.() ?? null,
          payout: {
            releaseMode: deps.releaseMode ?? null,
            releaseAvailable: Boolean(deps.runner),
            live: serialiseLiveBatch(deps.db),
          },
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
      // Sends through the channel DIRECTLY rather than through the notifier: a
      // test is an explicit act, so it deliberately bypasses both the severity
      // filter and the mute switch. Testing credentials on a channel you have
      // just muted is exactly when you need this.
      "/api/notify/test": postJson(async (body) => {
        const channel = deps.channels.find((c) => c.name === body.channel);
        if (!channel) return json({ error: `unknown channel "${String(body.channel)}"` }, 404);
        try {
          await channel.send({
            title: "[TEST] signum-testnet-rewards",
            body: "Test notification from the admin panel. No alert is active.",
            severity: "warning",
          });
          return json({ ok: true, channel: channel.name });
        } catch (e) {
          return json({ ok: false, channel: channel.name, error: describeError(e) });
        }
      }),

      "/api/notify/channel": postJson((body) => {
        const channel = deps.channels.find((c) => c.name === body.channel);
        if (!channel) return json({ error: `unknown channel "${String(body.channel)}"` }, 404);
        if (typeof body.enabled !== "boolean") {
          return json({ error: "enabled must be a boolean" }, 400);
        }
        setChannelEnabled(deps.db, channel.name, body.enabled);
        return json({ ok: true, channel: channel.name, enabled: body.enabled });
      }),

      /**
       * Signs and broadcasts the batch currently on screen.
       *
       * POST-only and token-gated like every mutation here, and it forwards the
       * operator's `expectedTotalPlanck` so the runner can refuse if a block
       * landed between the panel rendering the batch and this call.
       */
      "/api/payout/release": postJson(async (body) => {
        if (!deps.runner) return json({ error: "no payout runner is configured" }, 503);
        const expected = body.expectedTotalPlanck;
        if (expected !== undefined && typeof expected !== "string") {
          return json({ error: "expectedTotalPlanck must be a planck string" }, 400);
        }
        let outcome: RunOutcome;
        try {
          outcome = await deps.runner.release(expected);
        } catch (e) {
          // A throw here is a bug, not a payout outcome. It must not read as a
          // clean failure: the batch may be live and the reconciler owns it now.
          log.error("release threw", { error: describeError(e) });
          return json({ error: describeError(e) }, 500);
        }
        log.info("release requested", { outcome: outcome.kind });
        return json(outcome);
      }),

      "/api/payout/simulate": api(async (req) => {
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        if (!deps.simulate) return json({ error: "simulation unavailable" }, 503);
        try {
          return json(await deps.simulate(currentDryRun()));
        } catch (e) {
          return json({ built: false, error: describeError(e) }, 502);
        }
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
    /**
     * Last line of defence for a throwing route.
     *
     * Bun's default is a 500 whose stack goes to stdout outside our logger, and
     * whose body shape the panel cannot parse. This keeps the response JSON, so
     * the panel reports something useful, and puts the cause in the log where
     * the rest of the service's errors are.
     */
    error(err) {
      log.error("unhandled error in an admin route", { error: describeError(err) });
      return json({ error: "internal error" }, 500);
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
  };
}
