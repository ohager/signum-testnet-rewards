import { createClient } from "@libsql/client";
import type { Client, InStatement } from "@libsql/client";
import type { Projection } from "./projection.ts";
import { PUBLISH_SCHEMA_SQL, parseSchemaColumns } from "./tursoSchema.ts";
import { planPublish, emptyPublishState } from "./publishPlan.ts";
import type { PublishState } from "./publishPlan.ts";

export interface PublisherConfig {
  url: string;
  authToken: string;
  /** Longest gap between status writes, so `updated_at` still proves liveness. */
  heartbeatSeconds: number;
  /** How often the whole read-model is rewritten regardless of what changed. */
  fullSyncSeconds: number;
  /**
   * Rolling window for published payout history. `payouts` is the only table
   * here that grows with time; `status` is a single row and `miners` is bounded
   * by how many accounts have ever forged, not by how long we run.
   */
  retentionSeconds: number;
  now?: () => number;
}

/** What one publish tick actually sent. Returned so the caller can log or test it. */
export interface PublishOutcome {
  /** No statement was executed: nothing had changed. */
  skipped: boolean;
  statusWritten: boolean;
  minersWritten: number;
  payoutsWritten: number;
  fullSync: boolean;
  /** Rows dropped from the remote for falling outside the retention window. */
  payoutsDeleted: number;
  minersDeleted: number;
}

export interface Publisher {
  /**
   * Creates the read-model tables if they are missing.
   *
   * Optional to call: `publish` bootstraps on its own. Calling it at boot only
   * moves the first failure earlier, where it can be logged next to the other
   * boot lines instead of at the first publish tick.
   */
  init: () => Promise<void>;
  publish: (projection: Projection) => Promise<PublishOutcome>;
  close: () => void;
}

/**
 * Creates the read-model tables, then adds any column a newer build expects.
 *
 * The second step matters because a remote created by an earlier release is
 * untouched by `CREATE TABLE IF NOT EXISTS`, so a newly published field would
 * fail every push forever. Only ADDING is done — nothing is dropped or
 * retyped — so this can never destroy published data, and a column that has
 * gone away simply lingers unused until someone drops the database.
 */
async function createSchema(client: Client): Promise<void> {
  await client.executeMultiple(PUBLISH_SCHEMA_SQL);

  for (const [table, columns] of parseSchemaColumns(PUBLISH_SCHEMA_SQL)) {
    const existing = new Set(
      (await client.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r.name)),
    );
    for (const column of columns) {
      if (existing.has(column.name)) continue;
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`);
    }
  }
}

/**
 * Pushes the read-model to Turso.
 *
 * Needs no queue: every row is upserted from current state, so a failed push is
 * repaired by the next one rather than replayed. The local ledger stays
 * authoritative and this database can be dropped and rebuilt at any time.
 *
 * What it does keep is a fingerprint of what it last wrote, purely to avoid
 * rewriting rows that have not changed — see `publishPlan.ts`. That cache is
 * advisory: it is discarded on restart and reconciled by the periodic full sync,
 * so being wrong about it costs a redundant write, never a missing one.
 */
export function createTursoPublisher(cfg: PublisherConfig): Publisher {
  const client: Client = createClient({ url: cfg.url, authToken: cfg.authToken });
  const now = cfg.now ?? Date.now;
  let published: PublishState = emptyPublishState();

  // The bootstrap runs once per process and is cached as a promise so that
  // overlapping ticks share one attempt. A FAILED attempt is not cached: a
  // remote that was unreachable at boot must be able to bootstrap on any later
  // tick, exactly like a failed publish simply republishes next time.
  let bootstrap: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    bootstrap ??= createSchema(client).catch((e: unknown) => {
      bootstrap = undefined;
      throw e;
    });
    return bootstrap;
  };

  return {
    init: ensureSchema,

    async publish(projection) {
      const { plan, nextState } = planPublish(projection, published, {
        nowSeconds: Math.floor(now() / 1000),
        heartbeatSeconds: cfg.heartbeatSeconds,
        fullSyncSeconds: cfg.fullSyncSeconds,
      });

      const outcome: PublishOutcome = {
        skipped: plan.empty,
        statusWritten: plan.writeStatus,
        minersWritten: plan.miners.length,
        payoutsWritten: plan.payouts.length,
        fullSync: plan.fullSync,
        payoutsDeleted: 0,
        minersDeleted: 0,
      };

      // Nothing changed: do not even open a connection. This is the whole point
      // — a quiet interval must cost zero rows read and zero rows written.
      if (plan.empty) return outcome;

      await ensureSchema();

      const statements: InStatement[] = [];

      if (plan.writeStatus) statements.push(
        {
          sql: `INSERT INTO status (id, updated_at, service_status, payouts_enabled,
                                    payouts_paused, kill_switch, budget_remaining_planck,
                                    spent_today_planck, reward_per_block_planck,
                                    account_daily_cap_planck, global_daily_budget_planck,
                                    min_payout_planck,
                                    total_distributed_planck, pending_planck, miner_count,
                                    next_payout_at,
                                    payout_blocked_by, payout_due, last_payout_at, open_alerts)
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  updated_at               = excluded.updated_at,
                  service_status           = excluded.service_status,
                  payouts_enabled          = excluded.payouts_enabled,
                  payouts_paused           = excluded.payouts_paused,
                  kill_switch              = excluded.kill_switch,
                  budget_remaining_planck  = excluded.budget_remaining_planck,
                  spent_today_planck       = excluded.spent_today_planck,
                  reward_per_block_planck  = excluded.reward_per_block_planck,
                  account_daily_cap_planck = excluded.account_daily_cap_planck,
                  global_daily_budget_planck = excluded.global_daily_budget_planck,
                  min_payout_planck        = excluded.min_payout_planck,
                  total_distributed_planck = excluded.total_distributed_planck,
                  pending_planck           = excluded.pending_planck,
                  miner_count              = excluded.miner_count,
                  next_payout_at           = excluded.next_payout_at,
                  payout_blocked_by        = excluded.payout_blocked_by,
                  payout_due               = excluded.payout_due,
                  last_payout_at           = excluded.last_payout_at,
                  open_alerts              = excluded.open_alerts`,
          args: [
            projection.status.updatedAt,
            projection.status.openAlerts.length === 0 ? "ok" : "degraded",
            projection.status.payoutsEnabled ? 1 : 0,
            projection.status.payoutsPaused ? 1 : 0,
            projection.status.killSwitch ? 1 : 0,
            projection.status.budgetRemainingPlanck,
            projection.status.spentTodayPlanck,
            projection.status.rewardPerBlockPlanck,
            projection.status.accountDailyCapPlanck,
            projection.status.globalDailyBudgetPlanck,
            projection.status.minPayoutPlanck,
            projection.status.totalDistributedPlanck,
            projection.status.pendingPlanck,
            projection.status.minerCount,
            projection.status.nextPayoutAt,
            projection.status.payoutBlockedBy,
            projection.status.payoutDue ? 1 : 0,
            projection.status.lastPayoutAt,
            JSON.stringify(projection.status.openAlerts),
          ],
        },
      );

      statements.push(
        ...plan.miners.map((m) => ({
          sql: `INSERT INTO miners (account_id, account_rs, mainnet_account, blocks_mined,
                                    blocks_skipped, pending_planck, paid_planck,
                                    last_block_at, last_skip_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id) DO UPDATE SET
                  account_rs       = excluded.account_rs,
                  mainnet_account  = excluded.mainnet_account,
                  blocks_mined     = excluded.blocks_mined,
                  blocks_skipped   = excluded.blocks_skipped,
                  pending_planck   = excluded.pending_planck,
                  paid_planck      = excluded.paid_planck,
                  last_block_at    = excluded.last_block_at,
                  last_skip_reason = excluded.last_skip_reason`,
          args: [
            m.accountId, m.accountRS, m.mainnetAccount, m.blocksMined, m.blocksSkipped,
            m.pendingPlanck, m.paidPlanck, m.lastBlockAt, m.lastSkipReason,
          ],
        })),
        ...plan.payouts.map((p) => ({
          sql: `INSERT INTO payouts (batch_id, tx_id, confirmed_at, recipient_count, total_planck)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(batch_id) DO UPDATE SET
                  tx_id           = excluded.tx_id,
                  confirmed_at    = excluded.confirmed_at,
                  recipient_count = excluded.recipient_count,
                  total_planck    = excluded.total_planck`,
          args: [p.batchId, p.txId, p.confirmedAt, p.recipientCount, p.totalPlanck],
        })),
      );

      // Retention runs on the full sync only. Once an hour costs 24 statements a
      // day; running it every tick would spend writes to delete nothing.
      // A NULL confirmed_at is never matched: an unconfirmed payout has no age
      // yet, and `< NULL` would quietly delete nothing anyway.
      if (plan.fullSync) {
        const cutoff = Math.floor(now() / 1000) - cfg.retentionSeconds;
        statements.push({
          sql: `DELETE FROM payouts WHERE confirmed_at IS NOT NULL AND confirmed_at < ?`,
          args: [cutoff],
        });
        // Mirrors exactly what the projection now leaves out, so this deletes a
        // row once rather than fighting the next full sync over it. Anyone still
        // owed money is kept regardless of how long they have been idle.
        statements.push({
          sql: `DELETE FROM miners
                 WHERE pending_planck = 0
                   AND (last_block_at IS NULL OR last_block_at < ?)`,
          args: [cutoff],
        });
      }

      const results = await client.batch(statements, "write");
      if (plan.fullSync) {
        outcome.payoutsDeleted = results[results.length - 2]?.rowsAffected ?? 0;
        outcome.minersDeleted = results[results.length - 1]?.rowsAffected ?? 0;
      }

      // Adopted only now: a batch that threw wrote nothing, and remembering it
      // as published would leave the remote permanently behind.
      published = nextState;
      return outcome;
    },
    close() {
      client.close();
    },
  };
}
