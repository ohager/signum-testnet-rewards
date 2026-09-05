import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import type { Projection } from "./projection.ts";

export interface Publisher {
  publish: (projection: Projection) => Promise<void>;
  close: () => void;
}

/**
 * Pushes the read-model to Turso.
 *
 * Deliberately stateless: `status` and `miners` are upserted from current state
 * every tick, so a failed push needs no queue — the next tick simply republishes
 * the truth. That is why the local ledger stays authoritative and this database
 * can be dropped and rebuilt at any time.
 */
export function createTursoPublisher(cfg: { url: string; authToken: string }): Publisher {
  const client: Client = createClient({ url: cfg.url, authToken: cfg.authToken });

  return {
    async publish(projection) {
      const statements = [
        {
          sql: `INSERT INTO status (id, updated_at, service_status, payouts_enabled,
                                    payouts_paused, kill_switch, budget_remaining_planck,
                                    total_distributed_planck, open_alerts)
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  updated_at               = excluded.updated_at,
                  service_status           = excluded.service_status,
                  payouts_enabled          = excluded.payouts_enabled,
                  payouts_paused           = excluded.payouts_paused,
                  kill_switch              = excluded.kill_switch,
                  budget_remaining_planck  = excluded.budget_remaining_planck,
                  total_distributed_planck = excluded.total_distributed_planck,
                  open_alerts              = excluded.open_alerts`,
          args: [
            projection.status.updatedAt,
            projection.status.openAlerts.length === 0 ? "ok" : "degraded",
            1,
            projection.status.payoutsPaused ? 1 : 0,
            projection.status.killSwitch ? 1 : 0,
            projection.status.budgetRemainingPlanck,
            projection.status.totalDistributedPlanck,
            JSON.stringify(projection.status.openAlerts),
          ],
        },
        ...projection.miners.map((m) => ({
          sql: `INSERT INTO miners (account_id, blocks_mined, blocks_skipped,
                                    pending_planck, paid_planck, last_block_at, last_skip_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id) DO UPDATE SET
                  blocks_mined     = excluded.blocks_mined,
                  blocks_skipped   = excluded.blocks_skipped,
                  pending_planck   = excluded.pending_planck,
                  paid_planck      = excluded.paid_planck,
                  last_block_at    = excluded.last_block_at,
                  last_skip_reason = excluded.last_skip_reason`,
          args: [
            m.accountId, m.blocksMined, m.blocksSkipped,
            m.pendingPlanck, m.paidPlanck, m.lastBlockAt, m.lastSkipReason,
          ],
        })),
        ...projection.payouts.map((p) => ({
          sql: `INSERT INTO payouts (batch_id, tx_id, confirmed_at, recipient_count, total_planck)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(batch_id) DO UPDATE SET
                  tx_id           = excluded.tx_id,
                  confirmed_at    = excluded.confirmed_at,
                  recipient_count = excluded.recipient_count,
                  total_planck    = excluded.total_planck`,
          args: [p.batchId, p.txId, p.confirmedAt, p.recipientCount, p.totalPlanck],
        })),
      ];

      await client.batch(statements, "write");
    },
    close() {
      client.close();
    },
  };
}
