import type { BlockRewardStatus } from "../domain/types.ts";

export interface MainnetAccountFacts {
  /** True when the account exists on mainnet AND has a public key set. */
  isActive: boolean;
  publicKey: string | null;
}

export interface EligibilityInput {
  generatorPublicKey: string;
  excluded: boolean;
  mainnetAccount: MainnetAccountFacts | undefined;
}

export type EligibilityDecision =
  | { kind: "eligible" }
  | {
      kind: "ineligible";
      status: Extract<
        BlockRewardStatus,
        "skipped_no_mainnet_account" | "skipped_pubkey_mismatch" | "skipped_excluded"
      >;
    };

/**
 * Decides whether a testnet block generator may be paid on mainnet.
 *
 * Signum account ids derive from the public key, so an id match already implies
 * a key match. The explicit comparison closes the only theoretical hole for the
 * cost of one string compare, and a mismatch is surfaced as its own status so it
 * can be alerted on rather than blending into ordinary skips.
 */
export function decideEligibility(input: EligibilityInput): EligibilityDecision {
  if (input.excluded) {
    return { kind: "ineligible", status: "skipped_excluded" };
  }
  const account = input.mainnetAccount;
  if (!account || !account.isActive || !account.publicKey) {
    return { kind: "ineligible", status: "skipped_no_mainnet_account" };
  }
  if (account.publicKey.toLowerCase() !== input.generatorPublicKey.toLowerCase()) {
    return { kind: "ineligible", status: "skipped_pubkey_mismatch" };
  }
  return { kind: "eligible" };
}
