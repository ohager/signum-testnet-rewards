import type { Amount } from "@signumjs/util";
import type { Ledger } from "./db.ts";
import type { RecipientAmount } from "../domain/types.ts";
import { fromPlanckInt } from "../domain/money.ts";

/**
 * A batch's life, in order.
 *
 *  claimed     accruals are stamped but nothing has been sent, or the send
 *              threw and its outcome is unknown. The ONLY ambiguous state, and
 *              the only one the chain reconciler has to resolve.
 *  pending     accepted into a node's mempool: a transaction id exists.
 *  confirming  included in a block, but fewer than the required confirmations.
 *  confirmed   settled.
 *  failed      released -- the accruals went back into the unpaid pool.
 *
 * `pending` means "in the mempool", not "not yet sent": once a transaction id
 * exists the money is committed, and the states after it only describe how
 * deeply it has settled.
 */
export type BatchStatus = "claimed" | "pending" | "confirming" | "confirmed" | "failed";

/** Statuses where a transaction id exists, so the money has left or is leaving. */
export const SPENT_STATUSES = ["pending", "confirming", "confirmed"] as const;

/** Statuses still needing attention from the runner on each tick. */
export const LIVE_STATUSES = ["claimed", "pending", "confirming"] as const;

export class EmptyClaimError extends Error {
  constructor() {
    super("No unpaid accruals matched the requested recipients; nothing to claim");
    this.name = "EmptyClaimError";
  }
}

export interface UnpaidAggregate {
  recipientId: string;
  amount: Amount;
  accrualCount: number;
  /** Used for oldest-first fairness ordering during composition. */
  oldestCreatedAt: number;
}

export interface ClaimedBatch {
  batchId: number;
  recipients: RecipientAmount[];
  total: Amount;
}

export interface BatchRow {
  id: number;
  status: BatchStatus;
  recipientCount: number | null;
  total: Amount | null;
  txId: string | null;
  fullHash: string | null;
  /** The node that accepted the broadcast; confirmation polling is pinned to it. */
  broadcastHost: string | null;
  broadcastAt: number | null;
  confirmedHeight: number | null;
  attemptCount: number;
  deadlineAt: number | null;
  /** Epoch seconds the payout was confirmed on chain; null until it is. */
  confirmedAt: number | null;
  createdAt: number;
  lastError: string | null;
}

export function aggregateUnpaidByRecipient(db: Ledger): UnpaidAggregate[] {
  const rows = db
    .query(
      `SELECT generator_id       AS recipientId,
              SUM(amount_planck) AS totalPlanck,
              COUNT(*)           AS accrualCount,
              MIN(created_at)    AS oldestCreatedAt
         FROM unpaid_accruals
        GROUP BY generator_id`,
    )
    .all() as {
    recipientId: string;
    totalPlanck: number;
    accrualCount: number;
    oldestCreatedAt: number;
  }[];

  return rows.map((r) => ({
    recipientId: r.recipientId,
    amount: fromPlanckInt(r.totalPlanck),
    accrualCount: r.accrualCount,
    oldestCreatedAt: r.oldestCreatedAt,
  }));
}

/**
 * Atomically creates a batch and claims the named recipients' unpaid accruals.
 *
 * This is the second idempotency layer: block_rewards.batch_id moves from NULL
 * to a batch id exactly once, so an accrual can never be paid twice regardless
 * of what the chain walker replays. The whole thing is one transaction, so a
 * crash part-way through leaves neither a batch nor stamped accruals.
 */
export function claimBatch(
  db: Ledger,
  params: { recipientIds: string[]; deadlineAt: number },
): ClaimedBatch {
  const run = db.transaction((): ClaimedBatch => {
    const now = Math.floor(Date.now() / 1000);

    const insertBatch = db
      .query(
        `INSERT INTO batches (status, deadline_at, created_at, attempt_count)
         VALUES ('claimed', ?1, ?2, 0)`,
      )
      .run(params.deadlineAt, now);
    const batchId = Number(insertBatch.lastInsertRowid);

    const sumStmt = db.query(
      `SELECT COALESCE(SUM(amount_planck), 0) AS total
         FROM unpaid_accruals WHERE generator_id = ?1`,
    );
    const insertRecipient = db.query(
      `INSERT INTO batch_recipients (batch_id, recipient_id, amount_planck) VALUES (?1, ?2, ?3)`,
    );
    const stampAccruals = db.query(
      `UPDATE block_rewards SET batch_id = ?1
        WHERE generator_id = ?2 AND status = 'accrued' AND batch_id IS NULL`,
    );

    const recipients: RecipientAmount[] = [];
    let totalPlanck = 0;

    for (const recipientId of params.recipientIds) {
      const { total } = sumStmt.get(recipientId) as { total: number };
      if (total <= 0) continue;
      insertRecipient.run(batchId, recipientId, total);
      stampAccruals.run(batchId, recipientId);
      recipients.push({ recipientId, amount: fromPlanckInt(total) });
      totalPlanck += total;
    }

    // Throwing inside db.transaction rolls back the batch row created above.
    if (recipients.length === 0) throw new EmptyClaimError();

    db.query(`UPDATE batches SET recipient_count = ?1, total_planck = ?2 WHERE id = ?3`).run(
      recipients.length,
      totalPlanck,
      batchId,
    );

    return { batchId, recipients, total: fromPlanckInt(totalPlanck) };
  });

  return run();
}

/**
 * Records that a node accepted the broadcast.
 *
 * Written IMMEDIATELY after the send returns, because until this row exists the
 * service cannot name the transaction it just paid with. `host` is part of the
 * record, not incidental: every later confirmation check goes back to the same
 * node, since a different one answering "unknown" may simply never have seen it.
 */
export function markBroadcast(
  db: Ledger,
  batchId: number,
  tx: { txId: string; fullHash: string; host: string; feePlanck: number; broadcastAt: number },
): void {
  db.query(
    `UPDATE batches
        SET status = 'pending', tx_id = ?1, full_hash = ?2, broadcast_host = ?3,
            fee_planck = ?4, broadcast_at = ?5
      WHERE id = ?6`,
  ).run(tx.txId, tx.fullHash, tx.host, tx.feePlanck, tx.broadcastAt, batchId);
}

/** The transaction made it into a block but is not deep enough yet. */
export function markConfirming(db: Ledger, batchId: number, height: number): void {
  db.query(`UPDATE batches SET status = 'confirming', confirmed_height = ?1 WHERE id = ?2`).run(
    height,
    batchId,
  );
}

/** Terminal success: settled to the configured confirmation depth. */
export function markConfirmed(
  db: Ledger,
  batchId: number,
  at: { confirmedAt: number; height: number },
): void {
  db.query(
    `UPDATE batches SET status = 'confirmed', confirmed_at = ?1, confirmed_height = ?2
      WHERE id = ?3`,
  ).run(at.confirmedAt, at.height, batchId);
}

/**
 * The batch the runner still owes work on, if any.
 *
 * At most one exists by construction: nothing claims a new batch while this
 * returns a row, which is what keeps "any outgoing transaction from the payout
 * account in this window is ours" true for the reconciler.
 */
export function liveBatch(db: Ledger): BatchRow | undefined {
  const row = db
    .query(
      `SELECT * FROM batches
        WHERE status IN ('claimed','pending','confirming')
        ORDER BY id DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | null;
  return row ? toBatchRow(row) : undefined;
}

/** Counts an attempt that ended without a usable transaction. */
export function recordAttempt(db: Ledger, batchId: number, error: string): void {
  db.query(
    `UPDATE batches SET attempt_count = attempt_count + 1, last_error = ?1 WHERE id = ?2`,
  ).run(error, batchId);
}

/** Returns a failed batch's accruals to the unpaid pool so the next run retries them. */
export function releaseBatch(db: Ledger, batchId: number, reason: string): void {
  const run = db.transaction(() => {
    db.query(`UPDATE block_rewards SET batch_id = NULL WHERE batch_id = ?1`).run(batchId);
    db.query(`UPDATE batches SET status = 'failed', last_error = ?1 WHERE id = ?2`).run(
      reason,
      batchId,
    );
  });
  run();
}

function toBatchRow(row: Record<string, unknown>): BatchRow {
  const totalPlanck = row.total_planck as number | null;
  return {
    id: row.id as number,
    status: row.status as BatchStatus,
    recipientCount: (row.recipient_count as number | null) ?? null,
    total: totalPlanck === null ? null : fromPlanckInt(totalPlanck),
    txId: (row.tx_id as string | null) ?? null,
    fullHash: (row.full_hash as string | null) ?? null,
    broadcastHost: (row.broadcast_host as string | null) ?? null,
    broadcastAt: (row.broadcast_at as number | null) ?? null,
    confirmedHeight: (row.confirmed_height as number | null) ?? null,
    attemptCount: (row.attempt_count as number | null) ?? 0,
    deadlineAt: (row.deadline_at as number | null) ?? null,
    confirmedAt: (row.confirmed_at as number | null) ?? null,
    createdAt: row.created_at as number,
    lastError: (row.last_error as string | null) ?? null,
  };
}

const BATCH_COLUMNS =
  `id, status, recipient_count, total_planck, tx_id, full_hash, broadcast_host, broadcast_at,
   confirmed_height, attempt_count, deadline_at, confirmed_at, created_at, last_error`;

export function getBatch(db: Ledger, batchId: number): BatchRow | undefined {
  const row = db
    .query(`SELECT ${BATCH_COLUMNS} FROM batches WHERE id = ?1`)
    .get(batchId) as Record<string, unknown> | null;
  return row ? toBatchRow(row) : undefined;
}

export function listRecentBatches(db: Ledger, limit: number): BatchRow[] {
  const rows = db
    .query(`SELECT ${BATCH_COLUMNS} FROM batches ORDER BY id DESC LIMIT ?1`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(toBatchRow);
}

/**
 * When the last batch was claimed, regardless of how it ended.
 *
 * A failed batch still marks that the cycle ran, so it anchors the next one:
 * using only confirmed batches would make a run of failures look like payouts
 * were overdue by days.
 */
export function lastBatchCreatedAt(db: Ledger): number | undefined {
  const row = db.query(`SELECT MAX(created_at) AS at FROM batches`).get() as { at: number | null };
  return row.at ?? undefined;
}

/**
 * Total actually sent today, wall-clock, for the per-day spend rail.
 *
 * Counts every status that HAS a transaction id, not only settled ones: a
 * transaction still in the mempool is money already committed, and leaving it
 * out would let the daily rail authorise a second batch on top of it.
 */
export function sumBroadcastSinceWallClock(db: Ledger, sinceEpochSeconds: number): Amount {
  const row = db
    .query(
      `SELECT COALESCE(SUM(total_planck), 0) AS total
         FROM batches
        WHERE status IN ('pending','confirming','confirmed') AND created_at >= ?1`,
    )
    .get(sinceEpochSeconds) as { total: number };
  return fromPlanckInt(row.total);
}
