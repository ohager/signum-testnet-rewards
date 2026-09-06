import { test, expect, describe } from "bun:test";
import { planPublish, emptyPublishState } from "../../src/publish/publishPlan.ts";
import type { PublishState } from "../../src/publish/publishPlan.ts";
import type { Projection } from "../../src/publish/projection.ts";

const NOW = 1_800_000_000;
const OPTS = { nowSeconds: NOW, heartbeatSeconds: 60, fullSyncSeconds: 3_600 };

const projection = (over: Partial<Projection> = {}): Projection => ({
  status: {
    updatedAt: NOW,
    payoutsEnabled: true,
    payoutsPaused: false,
    killSwitch: false,
    budgetRemainingPlanck: 100_000_000,
    rewardPerBlockPlanck: 100_000_000,
    accountDailyCapPlanck: 1_000_000_000,
    globalDailyBudgetPlanck: 25_000_000_000,
    minPayoutPlanck: 500_000_000,
    testnetHeight: 1_204_331,
    lastForgerId: "acct-1",
    lastForgerRS: "TS-ACCT-0001",
    lastBlockForgedAt: NOW - 120,
    spentTodayPlanck: 150_000_000,
    totalDistributedPlanck: 250_000_000,
    pendingPlanck: 750_000_000,
    minerCount: 1,
    nextPayoutAt: NOW + 3_600,
    payoutBlockedBy: null,
    payoutDue: false,
    lastPayoutAt: NOW - 3_600,
    openAlerts: [],
  },
  miners: [
    {
      accountId: "acct-1", accountRS: "TS-ACCT-0001", mainnetAccount: "active", blocksMined: 3, blocksSkipped: 0,
      pendingPlanck: 750_000_000, paidPlanck: 0,
      lastBlockAt: 500_000, lastSkipReason: null,
    },
    {
      accountId: "acct-2", accountRS: "TS-ACCT-0002", mainnetAccount: "inactive", blocksMined: 1, blocksSkipped: 0,
      pendingPlanck: 250_000_000, paidPlanck: 0,
      lastBlockAt: 500_001, lastSkipReason: null,
    },
  ],
  payouts: [
    { batchId: 7, txId: "tx-7", confirmedAt: NOW - 3_600, recipientCount: 2, totalPlanck: 500_000_000 },
  ],
  ...over,
});

/** Publishes once so the state reflects a remote that is already up to date. */
const settled = (p = projection(), at = NOW): PublishState =>
  planPublish(p, emptyPublishState(), { ...OPTS, nowSeconds: at }).nextState;

describe("planPublish", () => {
  test("the first publish writes everything", () => {
    const { plan } = planPublish(projection(), emptyPublishState(), OPTS);
    expect(plan.fullSync).toBe(true);
    expect(plan.writeStatus).toBe(true);
    expect(plan.miners).toHaveLength(2);
    expect(plan.payouts).toHaveLength(1);
    expect(plan.empty).toBe(false);
  });

  test("A QUIET INTERVAL COSTS NOTHING: an unchanged projection sends no statement", () => {
    const state = settled();
    const { plan } = planPublish(projection(), state, { ...OPTS, nowSeconds: NOW + 30 });

    expect(plan.empty).toBe(true);
    expect(plan.writeStatus).toBe(false);
    expect(plan.miners).toEqual([]);
    expect(plan.payouts).toEqual([]);
  });

  test("only the miner that changed is written", () => {
    const state = settled();
    const next = projection();
    next.miners[1]!.blocksMined = 2;

    const { plan } = planPublish(next, state, { ...OPTS, nowSeconds: NOW + 30 });
    expect(plan.miners.map((m) => m.accountId)).toEqual(["acct-2"]);
  });

  test("an unchanged confirmed payout is never rewritten", () => {
    const state = settled();
    const next = projection();
    next.status.pendingPlanck = 1;

    const { plan } = planPublish(next, state, { ...OPTS, nowSeconds: NOW + 30 });
    expect(plan.writeStatus).toBe(true);
    expect(plan.payouts).toEqual([]);
  });

  test("a changed status is written even before the heartbeat is due", () => {
    const state = settled();
    const next = projection();
    next.status.killSwitch = true;

    const { plan } = planPublish(next, state, { ...OPTS, nowSeconds: NOW + 5 });
    expect(plan.writeStatus).toBe(true);
    expect(plan.miners).toEqual([]);
  });

  // Without a budget the remaining figure is null forever, so the day's spend is
  // the ONLY status field that moves as blocks accrue. Leaving it out of the
  // fingerprint would freeze the published card between heartbeats.
  test("a changed daily spend is a change, even when nothing else moved", () => {
    const state = settled();
    const next = projection();
    next.status.spentTodayPlanck = 900_000_000;

    const { plan } = planPublish(next, state, { ...OPTS, nowSeconds: NOW + 5 });
    expect(plan.writeStatus).toBe(true);
  });

  // An operator raising the cap changes what every future block earns. The page
  // states that figure, so it must not sit on the old one until the heartbeat.
  test("a re-tuned reward rule is a change", () => {
    const state = settled();
    const next = projection();
    next.status.accountDailyCapPlanck = 2_000_000_000;

    const { plan } = planPublish(next, state, { ...OPTS, nowSeconds: NOW + 5 });
    expect(plan.writeStatus).toBe(true);
  });

  // The page shows the chain moving, so a new head must not wait for the
  // heartbeat: between beats the height would sit still and read as a stall.
  test("a new testnet block is a change", () => {
    const state = settled();
    const next = projection();
    next.status.testnetHeight = 1_204_332;
    next.status.lastForgerId = "acct-2";
    next.status.lastBlockForgedAt = NOW - 10;

    const { plan } = planPublish(next, state, { ...OPTS, nowSeconds: NOW + 5 });
    expect(plan.writeStatus).toBe(true);
  });

  test("THE TIMESTAMP ALONE IS NOT A CHANGE", () => {
    const state = settled();
    const next = projection();
    next.status.updatedAt = NOW + 30;

    expect(planPublish(next, state, { ...OPTS, nowSeconds: NOW + 30 }).plan.empty).toBe(true);
  });

  test("the heartbeat refreshes the status so a quiet service is not read as dead", () => {
    const state = settled();
    const { plan } = planPublish(projection(), state, { ...OPTS, nowSeconds: NOW + 60 });

    expect(plan.writeStatus).toBe(true);
    expect(plan.miners).toEqual([]);
    expect(plan.fullSync).toBe(false);
  });

  test("a full sync rewrites every row even when nothing changed", () => {
    const state = settled();
    const { plan } = planPublish(projection(), state, { ...OPTS, nowSeconds: NOW + 3_600 });

    expect(plan.fullSync).toBe(true);
    expect(plan.miners).toHaveLength(2);
    expect(plan.payouts).toHaveLength(1);
  });

  test("a full sync forgets rows that are no longer in the projection", () => {
    const state = settled();
    const shrunk = projection({ miners: [projection().miners[0]!] });
    const after = planPublish(shrunk, state, { ...OPTS, nowSeconds: NOW + 3_600 }).nextState;

    expect([...after.miners.keys()]).toEqual(["acct-1"]);
  });

  test("between full syncs the timer is not restarted by ordinary writes", () => {
    const state = settled();
    const mid = planPublish(projection(), state, { ...OPTS, nowSeconds: NOW + 60 }).nextState;

    expect(mid.fullSyncAtSeconds).toBe(NOW);
    expect(planPublish(projection(), mid, { ...OPTS, nowSeconds: NOW + 3_600 }).plan.fullSync)
      .toBe(true);
  });

  test("the heartbeat clock only advances when the status is actually written", () => {
    const state = settled();
    const quiet = planPublish(projection(), state, { ...OPTS, nowSeconds: NOW + 30 }).nextState;

    expect(quiet.statusWrittenAtSeconds).toBe(NOW);
  });
});
