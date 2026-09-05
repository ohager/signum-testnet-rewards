import type { Block } from "@signumjs/core";
import { Amount } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { RewardPolicyConfig } from "../domain/policy.ts";
import type { MainnetAccountFacts } from "../eligibility/eligibility.ts";
import { decideEligibility } from "../eligibility/eligibility.ts";
import { decideReward } from "../domain/policy.ts";
import { toChainDay } from "../domain/chainDay.ts";
import {
  getBlockReward,
  recordBlockReward,
  sumAccruedForAccountOnDay,
  sumAccruedGlobalOnDay,
} from "../ledger/blockRewards.ts";

export interface BlockHandlerDeps {
  db: Ledger;
  policy: RewardPolicyConfig;
  lookupMainnetAccount: (accountId: string) => Promise<MainnetAccountFacts | undefined>;
  isExcluded: (accountId: string) => boolean;
}

/**
 * Scores one observed block and records the outcome.
 *
 * Every block produces a row, including skips: the status page answers
 * "why am I not getting paid?" from these rows, and dropping them would turn
 * that question into a support burden.
 *
 * The early return on an already-recorded block is an optimisation only. The
 * real guarantee against double-accrual is the INSERT OR IGNORE in
 * recordBlockReward, which holds even if two handlers race.
 */
export function createBlockHandler(deps: BlockHandlerDeps) {
  return async function handleBlock(block: Block): Promise<void> {
    const blockId = block.block;
    if (getBlockReward(deps.db, blockId)) return;

    const chainDay = toChainDay(block.timestamp);
    const generatorId = block.generator;
    const excluded = deps.isExcluded(generatorId);

    const base = {
      blockId,
      height: block.height,
      blockTimestamp: block.timestamp,
      chainDay,
      generatorId,
      generatorPublicKey: block.generatorPublicKey,
    };

    const mainnetAccount = excluded ? undefined : await deps.lookupMainnetAccount(generatorId);

    const eligibility = decideEligibility({
      generatorPublicKey: block.generatorPublicKey,
      excluded,
      mainnetAccount,
    });

    if (eligibility.kind === "ineligible") {
      recordBlockReward(deps.db, { ...base, status: eligibility.status, amount: Amount.Zero() });
      return;
    }

    const decision = decideReward(deps.policy, {
      accountAccruedToday: sumAccruedForAccountOnDay(deps.db, generatorId, chainDay),
      globalAccruedToday: sumAccruedGlobalOnDay(deps.db, chainDay),
    });

    if (decision.kind === "skip") {
      recordBlockReward(deps.db, { ...base, status: decision.status, amount: Amount.Zero() });
      return;
    }

    recordBlockReward(deps.db, { ...base, status: "accrued", amount: decision.amount });
  };
}
