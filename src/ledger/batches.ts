import type { Amount } from "@signumjs/util";
import type { Ledger } from "./db.ts";
import type { RecipientAmount } from "../domain/types.ts";
import { fromPlanckInt } from "../domain/money.ts";

export type BatchStatus = "pending" | "broadcast" | "confirmed" | "failed";

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
         VALUES ('pending', ?1, ?2, 0)`,
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
    deadlineAt: (row.deadline_at as number | null) ?? null,
    confirmedAt: (row.confirmed_at as number | null) ?? null,
    createdAt: row.created_at as number,
    lastError: (row.last_error as string | null) ?? null,
  };
}

const BATCH_COLUMNS =
  `id, status, recipient_count, total_planck, tx_id, deadline_at, confirmed_at, created_at, last_error`;

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

/** Total actually sent today, wall-clock, for the per-day spend rail. */
export function sumBroadcastSinceWallClock(db: Ledger, sinceEpochSeconds: number): Amount {
  const row = db
    .query(
      `SELECT COALESCE(SUM(total_planck), 0) AS total
         FROM batches
        WHERE status IN ('broadcast','confirmed') AND created_at >= ?1`,
    )
    .get(sinceEpochSeconds) as { total: number };
  return fromPlanckInt(row.total);
}
