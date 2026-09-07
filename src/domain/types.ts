import type { Amount } from "@signumjs/util";

/**
 * Whole planck, used ONLY as the SQLite storage representation.
 * Business logic uses Amount; see src/domain/money.ts.
 */
export type PlanckInt = number;

/** UTC calendar day derived from a block's chain timestamp, 'YYYY-MM-DD'. */
export type ChainDay = string;

export type BlockRewardStatus =
  | "accrued"
  /**
   * A reorg replaced this block. The row survives with its amount intact so the
   * history stays readable, but it is no longer accrued: it counts towards
   * nothing, and it can never be paid.
   */
  | "orphaned"
  | "skipped_no_mainnet_account"
  | "skipped_pubkey_mismatch"
  | "skipped_excluded"
  | "skipped_account_cap"
  | "skipped_global_cap";

export interface RecipientAmount {
  recipientId: string;
  amount: Amount;
}

export interface BatchDraft {
  recipients: RecipientAmount[];
  total: Amount;
}
