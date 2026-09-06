import type { Amount } from "@signumjs/util";
import type { BlockRewardStatus } from "./types.ts";

export interface RewardPolicyConfig {
  rewardPerBlock: Amount;
  accountDailyCap: Amount;
  globalDailyBudget: Amount;
}

export interface RewardContext {
  /** Already accrued to this account on this chain day. */
  accountAccruedToday: Amount;
  /** Already accrued across all accounts on this chain day. */
  globalAccruedToday: Amount;
}

export type RewardDecision =
  | { kind: "accrue"; amount: Amount }
  | {
      kind: "skip";
      status: Extract<BlockRewardStatus, "skipped_account_cap" | "skipped_global_cap">;
    };

/**
 * Decides what a single mined block earns.
 *
 * Rewards are all-or-nothing: if the full per-block reward does not fit under a
 * cap, the block is skipped rather than clamped. Clamping would produce dust of
 * unpredictable size and make the advertised per-block rate a lie.
 *
 * Every arithmetic step clones first, because Amount.add() mutates its receiver.
 */
export function decideReward(cfg: RewardPolicyConfig, ctx: RewardContext): RewardDecision {
  const projectedAccount = ctx.accountAccruedToday.clone().add(cfg.rewardPerBlock);
  if (projectedAccount.greater(cfg.accountDailyCap)) {
    return { kind: "skip", status: "skipped_account_cap" };
  }

  const projectedGlobal = ctx.globalAccruedToday.clone().add(cfg.rewardPerBlock);
  if (projectedGlobal.greater(cfg.globalDailyBudget)) {
    return { kind: "skip", status: "skipped_global_cap" };
  }

  // Cloned: handing out the config's own object would let a caller doing
  // arithmetic on the decision mutate the policy for every subsequent block.
  return { kind: "accrue", amount: cfg.rewardPerBlock.clone() };
}
