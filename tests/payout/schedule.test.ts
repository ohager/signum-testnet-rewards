import { test, expect, describe } from "bun:test";
import { computePayoutSchedule } from "../../src/payout/schedule.ts";
import type { PayoutScheduleInput } from "../../src/payout/schedule.ts";

const NOW = 1_800_000_000;
const HOUR = 3_600;

const input = (over: Partial<PayoutScheduleInput> = {}): PayoutScheduleInput => ({
  enabled: true,
  paused: false,
  killSwitch: false,
  lastRunAt: NOW - HOUR,
  serviceStartedAt: NOW - 5 * HOUR,
  intervalSeconds: 6 * HOUR,
  nowEpochSeconds: NOW,
  hasPayableRecipient: true,
  ...over,
});

describe("computePayoutSchedule", () => {
  test("schedules one interval after the last batch", () => {
    const s = computePayoutSchedule(input());
    expect(s.nextRunAt).toBe(NOW - HOUR + 6 * HOUR);
    expect(s.state).toBe("pending");
    expect(s.blockedBy).toBeUndefined();
  });

  test("anchors to service start before the first batch ever runs", () => {
    const s = computePayoutSchedule(input({ lastRunAt: undefined }));
    expect(s.nextRunAt).toBe(NOW - 5 * HOUR + 6 * HOUR);
    expect(s.lastRunAt).toBeUndefined();
  });

  test("A MISSED WINDOW IS DUE, NOT ROLLED FORWARD", () => {
    const s = computePayoutSchedule(input({ lastRunAt: NOW - 30 * HOUR }));
    expect(s.nextRunAt).toBe(NOW - 24 * HOUR);
    expect(s.state).toBe("due");
  });

  test("the exact boundary counts as due", () => {
    const s = computePayoutSchedule(input({ lastRunAt: NOW - 6 * HOUR }));
    expect(s.nextRunAt).toBe(NOW);
    expect(s.state).toBe("due");
  });

  test("NO TIME IS SHOWN WHEN PAYOUTS ARE DISABLED", () => {
    const s = computePayoutSchedule(input({ enabled: false }));
    expect(s.nextRunAt).toBeUndefined();
    expect(s.blockedBy).toBe("disabled");
    expect(s.state).toBe("blocked");
  });

  test("a tripped kill switch blocks the schedule", () => {
    expect(computePayoutSchedule(input({ killSwitch: true })).blockedBy).toBe("kill_switch");
  });

  test("a pause blocks the schedule", () => {
    expect(computePayoutSchedule(input({ paused: true })).blockedBy).toBe("paused");
  });

  test("the kill switch is reported ahead of a pause", () => {
    const s = computePayoutSchedule(input({ paused: true, killSwitch: true }));
    expect(s.blockedBy).toBe("kill_switch");
  });

  test("shadow mode is reported ahead of everything else", () => {
    const s = computePayoutSchedule(input({ enabled: false, paused: true, killSwitch: true }));
    expect(s.blockedBy).toBe("disabled");
  });

  test("the last run is still reported while blocked", () => {
    const s = computePayoutSchedule(input({ enabled: false }));
    expect(s.lastRunAt).toBe(NOW - HOUR);
  });

  describe("when nothing clears the minimum payout", () => {
    const overdueWithDust = (over: Partial<PayoutScheduleInput> = {}) =>
      computePayoutSchedule(
        input({ lastRunAt: NOW - 30 * HOUR, hasPayableRecipient: false, ...over }),
      );

    test("AN OVERDUE CYCLE IS POSTPONED, NOT DUE", () => {
      expect(overdueWithDust().state).toBe("postponed");
    });

    test("the elapsed time is still reported, so the wait stays visible", () => {
      expect(overdueWithDust().nextRunAt).toBe(NOW - 24 * HOUR);
    });

    test("postponement is not a blocker: nothing needs an operator", () => {
      expect(overdueWithDust().blockedBy).toBeUndefined();
    });

    test("a cycle that has not elapsed is pending, not postponed", () => {
      const s = computePayoutSchedule(input({ hasPayableRecipient: false }));
      expect(s.state).toBe("pending");
    });

    test("an operator blocker still outranks postponement", () => {
      expect(overdueWithDust({ paused: true }).state).toBe("blocked");
    });
  });
});
