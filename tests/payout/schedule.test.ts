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
  ...over,
});

describe("computePayoutSchedule", () => {
  test("schedules one interval after the last batch", () => {
    const s = computePayoutSchedule(input());
    expect(s.nextRunAt).toBe(NOW - HOUR + 6 * HOUR);
    expect(s.due).toBe(false);
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
    expect(s.due).toBe(true);
  });

  test("the exact boundary counts as due", () => {
    const s = computePayoutSchedule(input({ lastRunAt: NOW - 6 * HOUR }));
    expect(s.nextRunAt).toBe(NOW);
    expect(s.due).toBe(true);
  });

  test("NO TIME IS SHOWN WHEN PAYOUTS ARE DISABLED", () => {
    const s = computePayoutSchedule(input({ enabled: false }));
    expect(s.nextRunAt).toBeUndefined();
    expect(s.blockedBy).toBe("disabled");
    expect(s.due).toBe(false);
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
});
