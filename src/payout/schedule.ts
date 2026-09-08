/**
 * Why payouts are not scheduled. Reported instead of a time, never alongside
 * one: showing a countdown for a cycle that cannot run is worse than showing
 * nothing, because it looks like the money is on its way.
 */
export type PayoutBlocker = "disabled" | "paused" | "kill_switch";

/**
 * Where the payout cycle stands, as one value rather than a set of flags.
 *
 *  blocked    an operator or the configuration is holding payouts. No time is
 *             shown, because none is meaningful.
 *  pending    the interval has not elapsed yet. Counts down to `nextRunAt`.
 *  due        the interval has elapsed AND someone is actually payable.
 *  postponed  the interval has elapsed but nobody clears the minimum payout, so
 *             the accruals roll over and the cycle waits.
 *
 * `due` and `postponed` are separate states, not a boolean plus a caveat: a
 * cycle that cannot produce a batch must never be reported as due, because
 * "due now" reads as money already on its way.
 */
export type PayoutState = "blocked" | "pending" | "due" | "postponed";

export interface PayoutSchedule {
  /** Epoch seconds of the next run. Undefined exactly when `blockedBy` is set. */
  nextRunAt: number | undefined;
  blockedBy: PayoutBlocker | undefined;
  state: PayoutState;
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
  /**
   * Whether at least one recipient's unpaid total reaches the minimum payout.
   *
   * The minimum is a PER-RECIPIENT floor, so this is not "is anything owed":
   * ten miners holding a fifth of the minimum each are collectively owed twice
   * it and still produce no batch.
   */
  hasPayableRecipient: boolean;
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
 * A missed window is reported as elapsed, not rolled forward to the next slot.
 * If the service was down over several intervals, the honest statement is that a
 * payout is overdue — silently advancing the clock would hide that.
 *
 * An elapsed window only becomes `due` when someone is payable. Without that
 * check the panel would sit on "due now" forever: a cycle with nothing above the
 * minimum creates no batch, so the anchor never advances and the time never
 * moves. `postponed` says the same thing truthfully — the accruals roll over and
 * the cycle runs as soon as a balance reaches the minimum.
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
    state: "blocked",
    lastRunAt,
  });

  if (!input.enabled) return blocked("disabled");
  if (input.killSwitch) return blocked("kill_switch");
  if (input.paused) return blocked("paused");

  const anchor = lastRunAt ?? input.serviceStartedAt;
  const nextRunAt = anchor + input.intervalSeconds;
  const elapsed = nextRunAt <= input.nowEpochSeconds;

  return {
    nextRunAt,
    blockedBy: undefined,
    state: !elapsed ? "pending" : input.hasPayableRecipient ? "due" : "postponed",
    lastRunAt,
  };
}
