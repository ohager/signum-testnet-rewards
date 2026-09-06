import { Amount } from "@signumjs/util";
import { getAccountIdFromPublicKey } from "@signumjs/crypto";
import type { Ledger } from "../ledger/db.ts";
import type { RailsConfig } from "../domain/rails.ts";
import type { MainnetPool } from "../chain/mainnetPool.ts";
import type { Logger } from "../log.ts";
import { describeError, silentLogger } from "../log.ts";
import { toPlanckInt } from "../domain/money.ts";
import { dryRunBatch } from "./dryRun.ts";
import type { DryRunReport } from "./dryRun.ts";
import {
  claimBatch, markBroadcast, liveBatch, recordAttempt, sumBroadcastSinceWallClock,
} from "../ledger/batches.ts";
import { isPayoutsPaused, isKillSwitchTripped } from "../ledger/state.ts";
import { reconcileBatch } from "./reconcile.ts";
import type { ReconcileOutcome } from "./reconcile.ts";

/**
 * Who may start a payout.
 *
 * `armed` is the default for a service that has never moved money: the runner
 * composes and displays the batch every tick, but only an operator action sends
 * it. `auto` runs the identical path on the schedule -- the mode chooses the
 * caller, not the behaviour, so nothing about the payout differs between them.
 */
export type ReleaseMode = "armed" | "auto";

export type RunOutcome =
  | { kind: "blocked"; reason: string }
  | { kind: "nothing-to-pay" }
  | { kind: "sent"; batchId: number; txId: string; totalPlanck: string }
  | { kind: "send-failed"; batchId: number; error: string };

export interface PayoutRunnerDeps {
  db: Ledger;
  pool: MainnetPool;
  minPayout: Amount;
  rails: RailsConfig;
  fee: Amount;
  deadlineMinutes: number;
  confirmationsRequired: number;
  payoutsEnabled: boolean;
  /** Undefined in shadow mode: no seed, so nothing can be signed. */
  keys: { publicKey: string; signPrivateKey: string } | undefined;
  nowEpochSeconds: () => number;
  log?: Logger;
  /** Raised for conditions an operator has to act on. */
  onAlert?: (kind: string, message: string) => void;
}

export interface PayoutRunner {
  /**
   * Resolves any live batch, then reports what a payout would do. Never sends.
   * Safe to call on every block.
   */
  tick: () => Promise<ReconcileOutcome>;
  /**
   * Reconciles, checks every gate, then claims and sends.
   *
   * `expectedTotalPlanck` binds an operator's approval to the batch they were
   * shown: a block landing between render and click would otherwise send a
   * different amount than the one on screen.
   */
  release: (expectedTotalPlanck?: string) => Promise<RunOutcome>;
  /** The batch that would be sent right now, for the admin panel. */
  preview: () => DryRunReport;
}

const startOfWallClockDay = (nowEpochSeconds: number): number => {
  const d = new Date(nowEpochSeconds * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

export function createPayoutRunner(deps: PayoutRunnerDeps): PayoutRunner {
  const log = deps.log ?? silentLogger();
  const alert = (kind: string, message: string) => deps.onAlert?.(kind, message);

  const preview = (): DryRunReport =>
    dryRunBatch(deps.db, {
      minPayout: deps.minPayout,
      rails: deps.rails,
      spentToday: sumBroadcastSinceWallClock(deps.db, startOfWallClockDay(deps.nowEpochSeconds())),
    });

  const reconcile = () =>
    reconcileBatch(liveBatch(deps.db), {
      db: deps.db,
      pool: deps.pool,
      confirmationsRequired: deps.confirmationsRequired,
      nowEpochSeconds: deps.nowEpochSeconds,
    });

  /**
   * Everything that must hold before accruals are stamped.
   *
   * Ordered so the cheapest and most decisive checks run first, and so the
   * reason an operator sees is the most specific one that applies.
   */
  async function gate(): Promise<{ ok: false; reason: string } | { ok: true; report: DryRunReport }> {
    if (!deps.payoutsEnabled) return { ok: false, reason: "payouts are disabled by configuration" };
    if (isKillSwitchTripped(deps.db)) return { ok: false, reason: "the kill switch is tripped" };
    if (isPayoutsPaused(deps.db)) return { ok: false, reason: "payouts are paused" };
    if (!deps.keys) return { ok: false, reason: "no payout account seed is configured" };

    const report = preview();
    if (report.draft.recipients.length === 0) {
      return { ok: false, reason: "nothing is above the minimum payout" };
    }
    if (!report.railsVerdict.ok) {
      return {
        ok: false,
        reason: `rail ${report.railsVerdict.violation}: ${report.railsVerdict.detail}`,
      };
    }

    // Read live rather than trusting a cached balance: this is the last check
    // before money is committed, and one extra call every six hours is nothing.
    const required = report.draft.total.clone().add(deps.fee);
    const account = await deps.pool.getAccount(accountIdOf(deps.keys.publicKey));
    const balance = account ? BigInt(account.balanceNQT) : 0n;
    if (balance < BigInt(toPlanckInt(required))) {
      const reason =
        `payout account holds ${Amount.fromPlanck(balance.toString()).getSigna()} SIGNA, ` +
        `needs ${required.getSigna()} including fee`;
      alert("payout_underfunded", reason);
      return { ok: false, reason };
    }

    return { ok: true, report };
  }

  async function send(report: DryRunReport, batchId: number): Promise<RunOutcome> {
    const keys = deps.keys!;
    const recipients = report.draft.recipients;
    const common = {
      senderPublicKey: keys.publicKey,
      senderPrivateKey: keys.signPrivateKey,
      feePlanck: deps.fee.getPlanck(),
      deadline: deps.deadlineMinutes,
    };

    try {
      // signum-node rejects a multi-out below two recipients, so a single
      // recipient takes the ordinary send path.
      const result =
        recipients.length === 1
          ? await deps.pool.sendSingle({
              ...common,
              recipientId: recipients[0]!.recipientId,
              amountPlanck: recipients[0]!.amount.getPlanck(),
            })
          : await deps.pool.sendMultiOut({
              ...common,
              recipientAmounts: recipients.map((r) => ({
                recipient: r.recipientId,
                amountNQT: r.amount.getPlanck(),
              })),
            });

      markBroadcast(deps.db, batchId, {
        txId: result.transaction.transaction,
        fullHash: result.transaction.fullHash,
        host: result.host,
        feePlanck: toPlanckInt(deps.fee),
        broadcastAt: deps.nowEpochSeconds(),
      });
      log.info("payout broadcast", {
        batchId,
        txId: result.transaction.transaction,
        host: result.host,
        recipients: recipients.length,
        total: report.draft.total.getSigna(),
      });
      return {
        kind: "sent",
        batchId,
        txId: result.transaction.transaction,
        totalPlanck: report.draft.total.getPlanck(),
      };
    } catch (e) {
      // The outcome is UNKNOWN, not failed: the node may have accepted the
      // transaction and lost the response. The batch stays `claimed` so the
      // reconciler decides, and nothing is retried here -- a retry would build
      // a second transaction at a new timestamp and pay everyone twice.
      const error = describeError(e);
      recordAttempt(deps.db, batchId, error);
      log.error("payout send returned an error; outcome unknown until reconciled", {
        batchId,
        error,
      });
      alert("payout_send_unresolved", `Batch ${batchId} send failed: ${error}`);
      return { kind: "send-failed", batchId, error };
    }
  }

  return {
    preview,

    tick: reconcile,

    async release(expectedTotalPlanck?: string) {
      const outcome = await reconcile();
      // Never claim while a previous batch's fate is open. This is what keeps
      // "one live batch at a time" true, which the reconciler relies on.
      if (outcome.kind === "waiting" || outcome.kind === "confirming") {
        return { kind: "blocked", reason: `batch ${outcome.batchId} is still in flight` };
      }

      const gated = await gate();
      if (!gated.ok) return { kind: "blocked", reason: gated.reason };

      const total = gated.report.draft.total.getPlanck();
      if (expectedTotalPlanck !== undefined && expectedTotalPlanck !== total) {
        return {
          kind: "blocked",
          reason:
            `the batch changed since it was shown: ${total} planck now, ` +
            `${expectedTotalPlanck} when approved`,
        };
      }

      const claimed = claimBatch(deps.db, {
        recipientIds: gated.report.draft.recipients.map((r) => r.recipientId),
        deadlineAt: deps.nowEpochSeconds() + deps.deadlineMinutes * 60,
      });
      return send(gated.report, claimed.batchId);
    },
  };
}

/** Local derivation, so identifying our own account never needs the network. */
function accountIdOf(publicKey: string): string {
  return getAccountIdFromPublicKey(publicKey);
}
