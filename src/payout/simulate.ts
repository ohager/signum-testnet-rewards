import type { Amount } from "@signumjs/util";
import type { UnsignedTransaction } from "@signumjs/core";
import type { DryRunReport } from "./dryRun.ts";

/**
 * Builds the payout transaction WITHOUT signing or broadcasting it.
 *
 * The node assembles and validates the real transaction — fee, deadline,
 * attachment, recipient encoding — and hands back bytes nobody can spend. That
 * is worth far more than a locally constructed approximation: it is the same
 * code path the live payout will take, minus the signature.
 *
 * THE SAFETY PROPERTY: `senderPrivateKey` is never passed. SignumJS broadcasts
 * only when it is given one (see signIfPrivateKey), so omitting it is what makes
 * this a simulation. The returned `broadcasted` flag is checked anyway rather
 * than trusted, because the cost of being wrong is real money leaving the
 * account on a button labelled "simulate".
 */
export interface SignedNothing {
  signatureHash: string;
  unsignedTransactionBytes: string;
  transactionJSON: object;
}

export interface PayoutSimulation {
  /** False when no transaction could be built; `reason` says why. */
  built: boolean;
  reason?: string;
  recipientCount: number;
  totalPlanck: string;
  feePlanck: string;
  /** True when a single recipient forces an ordinary send instead of multi-out. */
  requiresOrdinarySend: boolean;
  railsVerdict: DryRunReport["railsVerdict"];
  transaction?: SignedNothing;
}

export class BroadcastAttemptedError extends Error {
  constructor() {
    super("Simulation received a broadcasted transaction; refusing to report it as a simulation");
    this.name = "BroadcastAttemptedError";
  }
}

export interface SimulationDeps {
  /** Undefined when PAYOUT_ACCOUNT_SEED is unset, i.e. shadow mode. */
  senderPublicKey: string | undefined;
  fee: Amount;
  deadlineMinutes: number;
  sendToMany: (args: {
    recipientAmounts: { recipient: string; amountNQT: string }[];
    senderPublicKey: string;
    feePlanck: string;
    deadline: number;
  }) => Promise<UnsignedTransaction>;
  sendToOne: (args: {
    recipientId: string;
    amountPlanck: string;
    senderPublicKey: string;
    feePlanck: string;
    deadline: number;
  }) => Promise<UnsignedTransaction>;
}

function withoutSecrets(tx: UnsignedTransaction): SignedNothing {
  if (tx.broadcasted) throw new BroadcastAttemptedError();
  return {
    signatureHash: tx.signatureHash,
    unsignedTransactionBytes: tx.unsignedTransactionBytes,
    transactionJSON: tx.transactionJSON,
  };
}

export async function simulatePayout(
  report: DryRunReport,
  deps: SimulationDeps,
): Promise<PayoutSimulation> {
  const base = {
    recipientCount: report.draft.recipients.length,
    totalPlanck: report.draft.total.getPlanck(),
    feePlanck: deps.fee.getPlanck(),
    requiresOrdinarySend: report.requiresOrdinarySend,
    railsVerdict: report.railsVerdict,
  };

  if (base.recipientCount === 0) {
    return { ...base, built: false, reason: "Nothing to pay: no accrual is above the minimum payout" };
  }
  if (!deps.senderPublicKey) {
    return {
      ...base,
      built: false,
      reason: "No payout account configured: set PAYOUT_ACCOUNT_SEED to build a transaction",
    };
  }

  const common = {
    senderPublicKey: deps.senderPublicKey,
    feePlanck: deps.fee.getPlanck(),
    deadline: deps.deadlineMinutes,
  };

  // A rails violation still builds the transaction. Seeing what WOULD have been
  // sent is the point of a simulation, and the verdict travels beside it.
  const tx = report.requiresOrdinarySend
    ? await deps.sendToOne({
        ...common,
        recipientId: report.draft.recipients[0]!.recipientId,
        amountPlanck: report.draft.recipients[0]!.amount.getPlanck(),
      })
    : await deps.sendToMany({
        ...common,
        recipientAmounts: report.draft.recipients.map((r) => ({
          recipient: r.recipientId,
          amountNQT: r.amount.getPlanck(),
        })),
      });

  return { ...base, built: true, transaction: withoutSecrets(tx) };
}
