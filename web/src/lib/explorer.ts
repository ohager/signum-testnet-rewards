/**
 * Links out to the block explorers.
 *
 * Two chains, two explorers, and the split matters: work is observed on testnet
 * but paid on mainnet, so an account on this page is worth looking up on
 * MAINNET — that is where the money lands and where a visitor can confirm it
 * arrived. Only the chain's own progress points at the testnet explorer.
 */
export const MAINNET_EXPLORER = "https://explorer.signum.network";
export const TESTNET_EXPLORER = "https://t-chain.signum.network";

/** Numeric account id, which both chains share by construction here. */
export function mainnetAddressUrl(accountId: string): string {
  return `${MAINNET_EXPLORER}/address/${encodeURIComponent(accountId)}`;
}
