import type { Ledger } from "../ledger/db.ts";
import type { BatchRow } from "../ledger/batches.ts";
import { markConfirming, markConfirmed, releaseBatch } from "../ledger/batches.ts";
import type { MainnetPool, TransactionLookup } from "../chain/mainnetPool.ts";

/**
 * What the reconciler decided about the live batch, for logging and alerting.
 *
 * `waiting` is a first-class outcome rather than a non-event: "we asked and
 * still do not know" is the correct state for a transaction whose deadline has
 * not passed, and it is the answer that keeps money safe.
 */
export type ReconcileOutcome =
  | { kind: "none" }
  | { kind: "waiting"; batchId: number; reason: string }
  | { kind: "settled"; batchId: number; height: number }
  | { kind: "confirming"; batchId: number; confirmations: number }
  | { kind: "released"; batchId: number; reason: string };

export interface ReconcileDeps {
  db: Ledger;
  pool: MainnetPool;
  confirmationsRequired: number;
  nowEpochSeconds: () => number;
}

/**
 * Where an unknown transaction is re-asked.
 *
 * The pinned host is authoritative for "yes it exists", but not for "no it does
 * not": signum-node keeps its unconfirmed pool in memory
 * (UnconfirmedTransactionStoreImpl.internalStore) and evicts cheapest-first
 * under load, so a restart or a busy mempool makes a live transaction vanish
 * from one node's view while peers still hold it. A second opinion catches
 * exactly those two cases.
 */
function otherHosts(pool: MainnetPool, pinned: string | null): string[] {
  return pool.hosts.filter((h) => h !== pinned);
}

/**
 * Resolves the one batch the runner still owes work on.
 *
 * Called before any new claim and on every tick, so nothing is ever paid while
 * a previous payout's fate is unknown.
 *
 * The rule that makes this safe: a batch is released ONLY once its deadline has
 * passed. Expiry is consensus-enforced -- BlockchainProcessorImpl rejects any
 * block carrying a transaction whose `getExpiration()` precedes the block
 * timestamp -- so after that moment the transaction cannot be included by
 * anyone. Before it, "no node can find it" is an observation about nodes, not
 * about the chain, and releasing on it would let a transaction confirm after
 * its accruals had already been handed to the next batch.
 *
 * Waiting costs at most one cycle, since a released batch is retried on the
 * next scheduled run rather than immediately. Being wrong costs a duplicate
 * payout to every recipient.
 */
export async function reconcileBatch(
  batch: BatchRow | undefined,
  deps: ReconcileDeps,
): Promise<ReconcileOutcome> {
  if (!batch) return { kind: "none" };

  // Claimed but never broadcast, or broadcast with an unknown outcome. Nothing
  // names a transaction, so the only question is whether the window is over.
  if (!batch.txId || !batch.broadcastHost) {
    return expireOrWait(batch, deps, "claimed but no transaction was recorded");
  }

  const lookup = await deps.pool.getTransaction(batch.broadcastHost, batch.txId);
  if (lookup.kind !== "unknown") return applyLookup(batch, lookup, deps);

  // Second opinion before believing it is gone.
  for (const host of otherHosts(deps.pool, batch.broadcastHost)) {
    let elsewhere: TransactionLookup;
    try {
      elsewhere = await deps.pool.getTransaction(host, batch.txId);
    } catch {
      // An unreachable fallback is not evidence of anything.
      continue;
    }
    if (elsewhere.kind !== "unknown") return applyLookup(batch, elsewhere, deps);
  }

  return expireOrWait(batch, deps, "no node has the transaction");
}

function applyLookup(
  batch: BatchRow,
  lookup: Exclude<TransactionLookup, { kind: "unknown" }>,
  deps: ReconcileDeps,
): ReconcileOutcome {
  if (lookup.kind === "mempool") {
    return { kind: "waiting", batchId: batch.id, reason: "in the mempool, not yet in a block" };
  }

  if (lookup.confirmations >= deps.confirmationsRequired) {
    markConfirmed(deps.db, batch.id, {
      confirmedAt: deps.nowEpochSeconds(),
      height: lookup.height,
    });
    return { kind: "settled", batchId: batch.id, height: lookup.height };
  }

  // In a block but not deep enough. Distinct from `pending` because it can no
  // longer be dropped at the deadline -- only a mainnet reorg would undo it.
  markConfirming(deps.db, batch.id, lookup.height);
  return { kind: "confirming", batchId: batch.id, confirmations: lookup.confirmations };
}

function expireOrWait(
  batch: BatchRow,
  deps: ReconcileDeps,
  reason: string,
): ReconcileOutcome {
  const now = deps.nowEpochSeconds();
  if (batch.deadlineAt !== null && now <= batch.deadlineAt) {
    return { kind: "waiting", batchId: batch.id, reason };
  }

  const detail = `${reason}; deadline passed, releasing for the next cycle`;
  releaseBatch(deps.db, batch.id, detail);
  return { kind: "released", batchId: batch.id, reason: detail };
}
