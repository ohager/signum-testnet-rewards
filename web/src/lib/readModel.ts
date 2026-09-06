/**
 * The published read-model, as the public site sees it.
 *
 * These declarations are a COPY of the contract the service owns in
 * `src/publish/tursoSchema.ts`, not an import of it. The service and this app
 * are separate deployment roots with separate dependency trees — the service
 * runs on a VPS under pm2, this runs on Vercel — and reaching across that
 * boundary would drag Bun-flavoured `.ts` import specifiers into Next's
 * resolver for the sake of one file.
 *
 * The copy is not left to trust: `tests/publish/readModelContract.test.ts` in
 * the service checks `READ_MODEL_COLUMNS` below against the real DDL, so
 * renaming or dropping a published column fails the service's test suite until
 * this file is updated. The dependency runs in the right direction — the
 * service owns the schema, this app is a consumer that must be verified
 * against it.
 *
 * Every amount is an INTEGER planck value. libSQL returns SQLite INTEGERs as
 * JavaScript numbers, which is exact below 2^53 — about 90 million SIGNA — but
 * the row decoders below convert to `bigint` at the boundary so that formatting
 * never has to reason about that ceiling.
 */

/** Mirrors `MainnetAccountState` in the service's projection. */
export type MainnetAccountState = "active" | "inactive" | "unknown";

/** Why there is no next payout. Mirrors `PayoutBlocker` in the service. */
export type PayoutBlocker = "disabled" | "paused" | "kill_switch";

export interface Status {
  /** Epoch seconds of the last publish. The site's staleness signal. */
  updatedAt: number;
  serviceStatus: "ok" | "degraded";
  payoutsEnabled: boolean;
  payoutsPaused: boolean;
  killSwitch: boolean;
  /**
   * What is left of today's allowance, clamped at zero by the service.
   * Null when the deployment configures no daily ceiling at all, which the
   * page shows as unlimited rather than as an exhausted budget.
   */
  budgetRemainingPlanck: bigint | null;
  /**
   * What today's accruals consumed, INCLUDING any already paid out: the
   * budget is spent at accrual and a payout does not return it. Shown next
   * to the remainder so the two cards read as one sentence.
   */
  spentTodayPlanck: bigint;
  totalDistributedPlanck: bigint;
  /** Total still owed across every miner. */
  pendingPlanck: bigint;
  /** Carried here so the headline costs a single row read. */
  minerCount: number;
  /** Epoch seconds. Null exactly when `payoutBlockedBy` is set. */
  nextPayoutAt: number | null;
  payoutBlockedBy: PayoutBlocker | null;
  payoutDue: boolean;
  lastPayoutAt: number | null;
  openAlerts: string[];
}

export interface Miner {
  accountId: string;
  /** Reed-Solomon form, testnet-prefixed. Null only on rows written before it existed. */
  accountRS: string | null;
  mainnetAccount: MainnetAccountState;
  blocksMined: number;
  blocksSkipped: number;
  pendingPlanck: bigint;
  paidPlanck: bigint;
  /** Epoch seconds, already converted from chain time by the service. */
  lastBlockAt: number | null;
  lastSkipReason: string | null;
}

export interface Payout {
  batchId: number;
  txId: string | null;
  confirmedAt: number | null;
  recipientCount: number | null;
  totalPlanck: bigint | null;
}

/**
 * The columns this app reads, by table.
 *
 * Verified as a SUBSET of the service's DDL — a subset rather than an equality
 * because the site is free to ignore published columns it has no use for, but
 * must never read one that does not exist.
 */
export const READ_MODEL_COLUMNS = {
  status: [
    "updated_at",
    "service_status",
    "payouts_enabled",
    "payouts_paused",
    "kill_switch",
    "budget_remaining_planck",
    "spent_today_planck",
    "total_distributed_planck",
    "pending_planck",
    "miner_count",
    "next_payout_at",
    "payout_blocked_by",
    "payout_due",
    "last_payout_at",
    "open_alerts",
  ],
  miners: [
    "account_id",
    "account_rs",
    "mainnet_account",
    "blocks_mined",
    "blocks_skipped",
    "pending_planck",
    "paid_planck",
    "last_block_at",
    "last_skip_reason",
  ],
  payouts: ["batch_id", "tx_id", "confirmed_at", "recipient_count", "total_planck"],
} as const satisfies Record<string, readonly string[]>;

/* ── row decoding ──────────────────────────────────────────────────────────
 * libSQL hands back `unknown` per column. These helpers are the one place that
 * narrowing happens, so a schema surprise surfaces as a clear error here rather
 * than as `NaN` three components deep.
 */

const int = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const nullableInt = (v: unknown): number | null => (v === null || v === undefined ? null : int(v));
const planck = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(v as number));
const nullablePlanck = (v: unknown): bigint | null =>
  v === null || v === undefined ? null : BigInt(v as number);
const bool = (v: unknown): boolean => int(v) === 1;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** A single libSQL result row, keyed by column name. */
export type Row = Record<string, unknown>;

export function decodeStatus(row: Row): Status {
  return {
    updatedAt: int(row.updated_at),
    serviceStatus: row.service_status === "ok" ? "ok" : "degraded",
    payoutsEnabled: bool(row.payouts_enabled),
    payoutsPaused: bool(row.payouts_paused),
    killSwitch: bool(row.kill_switch),
    budgetRemainingPlanck: nullablePlanck(row.budget_remaining_planck),
    spentTodayPlanck: planck(row.spent_today_planck),
    totalDistributedPlanck: planck(row.total_distributed_planck),
    pendingPlanck: planck(row.pending_planck),
    minerCount: int(row.miner_count),
    nextPayoutAt: nullableInt(row.next_payout_at),
    payoutBlockedBy: (str(row.payout_blocked_by) as PayoutBlocker | null) ?? null,
    payoutDue: bool(row.payout_due),
    lastPayoutAt: nullableInt(row.last_payout_at),
    openAlerts: parseAlerts(row.open_alerts),
  };
}

/**
 * `open_alerts` is a JSON array written by the publisher. A malformed value is
 * treated as "no alerts" rather than throwing: a status page that renders
 * nothing at all because one advisory field is corrupt would be worse than one
 * that under-reports it, and the field is decoration around the money figures.
 */
function parseAlerts(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function decodeMiner(row: Row): Miner {
  const mainnet = str(row.mainnet_account);
  return {
    accountId: String(row.account_id),
    accountRS: str(row.account_rs),
    mainnetAccount:
      mainnet === "active" || mainnet === "inactive" ? mainnet : "unknown",
    blocksMined: int(row.blocks_mined),
    blocksSkipped: int(row.blocks_skipped),
    pendingPlanck: planck(row.pending_planck),
    paidPlanck: planck(row.paid_planck),
    lastBlockAt: nullableInt(row.last_block_at),
    lastSkipReason: str(row.last_skip_reason),
  };
}

export interface Snapshot {
  status: Status;
  miners: Miner[];
  payouts: Payout[];
}

/* ── wire format ───────────────────────────────────────────────────────────
 * What crosses the HTTP boundary to the browser.
 *
 * JSON has no bigint, so every planck value travels as a decimal STRING and is
 * widened back to bigint on arrival. Sending them as numbers would work today
 * and start silently truncating somewhere north of 90 million SIGNA, which is
 * exactly the kind of bug that shows up once the programme succeeds.
 */

type Planckify<T> = {
  [K in keyof T]: T[K] extends bigint ? string : T[K] extends bigint | null ? string | null : T[K];
};

export type StatusWire = Planckify<Status>;
export type MinerWire = Planckify<Miner>;
export type PayoutWire = Planckify<Payout>;

export interface SnapshotWire {
  status: StatusWire;
  miners: MinerWire[];
  payouts: PayoutWire[];
}

export function toWire(snapshot: Snapshot): SnapshotWire {
  return {
    status: {
      ...snapshot.status,
      budgetRemainingPlanck:
        snapshot.status.budgetRemainingPlanck === null
          ? null
          : snapshot.status.budgetRemainingPlanck.toString(),
      spentTodayPlanck: snapshot.status.spentTodayPlanck.toString(),
      totalDistributedPlanck: snapshot.status.totalDistributedPlanck.toString(),
      pendingPlanck: snapshot.status.pendingPlanck.toString(),
    },
    miners: snapshot.miners.map((m) => ({
      ...m,
      pendingPlanck: m.pendingPlanck.toString(),
      paidPlanck: m.paidPlanck.toString(),
    })),
    payouts: snapshot.payouts.map((p) => ({
      ...p,
      totalPlanck: p.totalPlanck === null ? null : p.totalPlanck.toString(),
    })),
  };
}

export function fromWire(wire: SnapshotWire): Snapshot {
  return {
    status: {
      ...wire.status,
      budgetRemainingPlanck:
        wire.status.budgetRemainingPlanck === null
          ? null
          : BigInt(wire.status.budgetRemainingPlanck),
      spentTodayPlanck: BigInt(wire.status.spentTodayPlanck),
      totalDistributedPlanck: BigInt(wire.status.totalDistributedPlanck),
      pendingPlanck: BigInt(wire.status.pendingPlanck),
    },
    miners: wire.miners.map((m) => ({
      ...m,
      pendingPlanck: BigInt(m.pendingPlanck),
      paidPlanck: BigInt(m.paidPlanck),
    })),
    payouts: wire.payouts.map((p) => ({
      ...p,
      totalPlanck: p.totalPlanck === null ? null : BigInt(p.totalPlanck),
    })),
  };
}

export function decodePayout(row: Row): Payout {
  return {
    batchId: int(row.batch_id),
    txId: str(row.tx_id),
    confirmedAt: nullableInt(row.confirmed_at),
    recipientCount: nullableInt(row.recipient_count),
    totalPlanck: nullablePlanck(row.total_planck),
  };
}
