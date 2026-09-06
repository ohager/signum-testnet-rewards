/**
 * Why payouts are not scheduled. Reported instead of a time, never alongside
 * one: showing a countdown for a cycle that cannot run is worse than showing
 * nothing, because it looks like the money is on its way.
 */
export type PayoutBlocker = "disabled" | "paused" | "kill_switch";

export interface PayoutSchedule {
  /** Epoch seconds of the next run. Undefined exactly when `blockedBy` is set. */
  nextRunAt: number | undefined;
  blockedBy: PayoutBlocker | undefined;
  /** The next run is already in the past — the cycle is due rather than pending. */
  due: boolean;
  /** When the last batch was claimed, if any. */
  lastRunAt: number | undefined;
}

export interface PayoutScheduleInput {
  enabled: boolean;
  paused: boolean;
  killSwitch: boolean;
  /** Creation time of the most recent batch, or undefined if none has ever run. */
  lastRunAt: number | undefined;
  /** Fallback anchor before the first batch: payouts start one interval after boot. */
  serviceStartedAt: number;
  intervalSeconds: number;
  nowEpochSeconds: number;
}

/**
 * Derives when the next payout cycle is expected.
 *
 * The schedule is ANCHORED to the last batch rather than to a wall-clock grid,
 * because that is what a periodic runner actually does: the cycle after a batch
 * is one interval after that batch, not at the next round hour. Before the first
 * batch the anchor is service start, so a fresh deployment shows a real time
 * instead of "never".
 *
 * A missed window is reported as `due`, not rolled forward to the next slot. If
 * the service was down over several intervals, the honest statement is that a
 * payout is overdue — silently advancing the clock would hide that.
 *
 * Blocker precedence is config, then kill switch, then pause: `disabled` means
 * no runner exists at all, which makes the other two moot, and an operator
 * reading "paused" while the kill switch is latched would clear the wrong thing.
 */
export function computePayoutSchedule(input: PayoutScheduleInput): PayoutSchedule {
  const lastRunAt = input.lastRunAt;

  const blocked = (blockedBy: PayoutBlocker): PayoutSchedule => ({
    nextRunAt: undefined,
    blockedBy,
    due: false,
    lastRunAt,
  });

  if (!input.enabled) return blocked("disabled");
  if (input.killSwitch) return blocked("kill_switch");
  if (input.paused) return blocked("paused");

  const anchor = lastRunAt ?? input.serviceStartedAt;
  const nextRunAt = anchor + input.intervalSeconds;

  return {
    nextRunAt,
    blockedBy: undefined,
    due: nextRunAt <= input.nowEpochSeconds,
    lastRunAt,
  };
}
