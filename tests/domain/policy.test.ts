import { test, expect, describe } from "bun:test";
import { Amount } from "@signumjs/util";
import { decideReward } from "../../src/domain/policy.ts";
import type { RewardPolicyConfig, RewardContext } from "../../src/domain/policy.ts";

const cfg: RewardPolicyConfig = {
  rewardPerBlock: Amount.fromSigna("2.5"),
  accountDailyCap: Amount.fromSigna("100"),
  globalDailyBudget: Amount.fromSigna("1000"),
};

const ctx = (accountSigna: string, globalSigna: string): RewardContext => ({
  accountAccruedToday: Amount.fromSigna(accountSigna),
  globalAccruedToday: Amount.fromSigna(globalSigna),
});

describe("decideReward", () => {
  test("accrues the full reward when well under both caps", () => {
    const decision = decideReward(cfg, ctx("0", "0"));
    expect(decision.kind).toBe("accrue");
    if (decision.kind === "accrue") expect(decision.amount.getSigna()).toBe("2.5");
  });

  test("accrues when the reward exactly fills the account cap", () => {
    expect(decideReward(cfg, ctx("97.5", "0")).kind).toBe("accrue");
  });

  test("skips when the reward would exceed the account cap", () => {
    expect(decideReward(cfg, ctx("98", "0"))).toEqual({
      kind: "skip",
      status: "skipped_account_cap",
    });
  });

  test("skips when the reward would exceed the global budget", () => {
    expect(decideReward(cfg, ctx("0", "998"))).toEqual({
      kind: "skip",
      status: "skipped_global_cap",
    });
  });

  test("accrues when the reward exactly fills the global budget", () => {
    expect(decideReward(cfg, ctx("0", "997.5")).kind).toBe("accrue");
  });

  test("account cap takes precedence when both would be exceeded", () => {
    expect(decideReward(cfg, ctx("100", "1000"))).toEqual({
      kind: "skip",
      status: "skipped_account_cap",
    });
  });

  test("MUTATION SAFETY: deciding does not modify the config amounts", () => {
    decideReward(cfg, ctx("50", "500"));
    decideReward(cfg, ctx("50", "500"));
    expect(cfg.rewardPerBlock.getSigna()).toBe("2.5");
    expect(cfg.accountDailyCap.getSigna()).toBe("100");
    expect(cfg.globalDailyBudget.getSigna()).toBe("1000");
  });

  test("MUTATION SAFETY: deciding does not modify the context amounts", () => {
    const context = ctx("50", "500");
    decideReward(cfg, context);
    expect(context.accountAccruedToday.getSigna()).toBe("50");
    expect(context.globalAccruedToday.getSigna()).toBe("500");
  });

  test("MUTATION SAFETY: mutating a returned amount cannot corrupt the policy", () => {
    const decision = decideReward(cfg, ctx("0", "0"));
    if (decision.kind === "accrue") decision.amount.add(Amount.fromSigna("1000"));
    expect(cfg.rewardPerBlock.getSigna()).toBe("2.5");
  });

  test("never returns a partial amount", () => {
    const decision = decideReward(cfg, ctx("99", "0"));
    if (decision.kind === "accrue") {
      expect(decision.amount.getSigna()).toBe(cfg.rewardPerBlock.getSigna());
    } else {
      expect(decision.status).toBe("skipped_account_cap");
    }
  });
});
