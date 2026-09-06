import { Address, AddressPrefix } from "@signumjs/core";

/**
 * Numeric ids are what the chain reports and what the ledger stores; Reed-Solomon
 * is the only form a person can check against a wallet or an explorer. Converting
 * at the read-model boundary keeps the storage form canonical and the displayed
 * form human.
 *
 * Memoised because the projection is rebuilt on every admin poll and every
 * publish tick, and an account's address never changes. The map is bounded by
 * the number of accounts that have ever forged a block.
 */
const cache = new Map<string, string>();

/**
 * Testnet prefix, because every account in this ledger is a testnet forger.
 * The same numeric id on mainnet would render `S-…`, and showing that here would
 * point an operator at the wrong chain's explorer.
 */
export function toReedSolomon(accountId: string): string {
  const cached = cache.get(accountId);
  if (cached) return cached;

  let rs: string;
  try {
    rs = Address.create(accountId, AddressPrefix.TestNet).getReedSolomonAddress();
  } catch {
    // A display conversion must never be able to break the read-model. An id we
    // cannot render is shown as itself.
    rs = accountId;
  }

  cache.set(accountId, rs);
  return rs;
}
