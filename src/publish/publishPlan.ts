import type { Projection, MinerRow, PayoutRow, StatusRow } from "./projection.ts";

/**
 * What the remote is believed to hold, as content fingerprints.
 *
 * In memory only, and deliberately so: it is a cache of what THIS process wrote,
 * never a claim about the remote's true state. A restart empties it and the next
 * publish rewrites everything, which is the correct response to not knowing.
 */
export interface PublishState {
  /** Fingerprint of the status row EXCLUDING its timestamp. */
  status: string | undefined;
  statusWrittenAtSeconds: number | undefined;
  miners: Map<string, string>;
  payouts: Map<number, string>;
  fullSyncAtSeconds: number | undefined;
}

export interface PublishPlan {
  writeStatus: boolean;
  miners: MinerRow[];
  payouts: PayoutRow[];
  /** Everything is being rewritten, either on the first publish or on a resync. */
  fullSync: boolean;
  /** Nothing to send: the caller must not open a connection at all. */
  empty: boolean;
}

export interface PlanOptions {
  nowSeconds: number;
  /**
   * Longest gap allowed between status writes, so a consumer watching
   * `updated_at` can still tell a quiet service from a dead one.
   */
  heartbeatSeconds: number;
  /** How often everything is rewritten regardless of fingerprints. */
  fullSyncSeconds: number;
}

export function emptyPublishState(): PublishState {
  return {
    status: undefined,
    statusWrittenAtSeconds: undefined,
    miners: new Map(),
    payouts: new Map(),
    fullSyncAtSeconds: undefined,
  };
}

/**
 * Field order is fixed by the literal, so the same content always produces the
 * same string. `updatedAt` is excluded on purpose: it changes every tick by
 * construction and would make every row look dirty forever.
 */
const statusFingerprint = (s: StatusRow): string =>
  JSON.stringify([
    s.payoutsEnabled, s.payoutsPaused, s.killSwitch,
    s.budgetRemainingPlanck, s.totalDistributedPlanck, s.pendingPlanck, s.minerCount,
    s.nextPayoutAt, s.payoutBlockedBy, s.payoutDue, s.lastPayoutAt,
    s.openAlerts,
  ]);

const minerFingerprint = (m: MinerRow): string =>
  JSON.stringify([
    m.blocksMined, m.blocksSkipped, m.pendingPlanck, m.paidPlanck,
    m.lastBlockAt, m.lastSkipReason, m.mainnetAccount,
  ]);

const payoutFingerprint = (p: PayoutRow): string =>
  JSON.stringify([p.txId, p.confirmedAt, p.recipientCount, p.totalPlanck]);

/**
 * Decides what actually has to be written this tick.
 *
 * The publisher republished the entire read-model every interval, which cost a
 * row read and a row write per miner per tick whether or not anything had
 * happened — and on a testnet most miners are unchanged most of the time. This
 * sends only rows whose CONTENT changed, so a quiet minute costs nothing at all.
 *
 * Two escape hatches keep that from drifting away from the truth:
 *  - the status row is written at least every `heartbeatSeconds`, because a page
 *    that watches `updated_at` must be able to distinguish quiet from dead;
 *  - everything is rewritten every `fullSyncSeconds`, which repairs a remote
 *    that was edited, restored or truncated behind our back.
 *
 * Returns the plan AND the state to adopt — but the caller must only adopt it
 * after the write succeeds, or a failed batch would be remembered as published.
 */
export function planPublish(
  projection: Projection,
  state: PublishState,
  opts: PlanOptions,
): { plan: PublishPlan; nextState: PublishState } {
  const fullSync =
    state.fullSyncAtSeconds === undefined ||
    opts.nowSeconds - state.fullSyncAtSeconds >= opts.fullSyncSeconds;

  const status = statusFingerprint(projection.status);
  const heartbeatDue =
    state.statusWrittenAtSeconds === undefined ||
    opts.nowSeconds - state.statusWrittenAtSeconds >= opts.heartbeatSeconds;
  const writeStatus = fullSync || heartbeatDue || status !== state.status;

  const miners = projection.miners.filter(
    (m) => fullSync || state.miners.get(m.accountId) !== minerFingerprint(m),
  );
  const payouts = projection.payouts.filter(
    (p) => fullSync || state.payouts.get(p.batchId) !== payoutFingerprint(p),
  );

  const nextMiners = new Map(fullSync ? undefined : state.miners);
  for (const m of projection.miners) nextMiners.set(m.accountId, minerFingerprint(m));
  const nextPayouts = new Map(fullSync ? undefined : state.payouts);
  for (const p of projection.payouts) nextPayouts.set(p.batchId, payoutFingerprint(p));

  return {
    plan: {
      writeStatus,
      miners,
      payouts,
      fullSync,
      empty: !writeStatus && miners.length === 0 && payouts.length === 0,
    },
    nextState: {
      status,
      statusWrittenAtSeconds: writeStatus ? opts.nowSeconds : state.statusWrittenAtSeconds,
      miners: nextMiners,
      payouts: nextPayouts,
      fullSyncAtSeconds: fullSync ? opts.nowSeconds : state.fullSyncAtSeconds,
    },
  };
}
