import { Address, AddressPrefix } from "@signumjs/core";
import type { MainnetAccountResult } from "../chain/mainnetPool.ts";
import { describeError } from "../log.ts";

/**
 * What the admin panel shows about the account the rewards are paid FROM.
 *
 * The identity and the balance are separate fields because they are known with
 * very different confidence. The address is derived locally from the public key
 * and is therefore always correct; the balance comes off mainnet and may be
 * absent, stale, or unavailable. Merging them into one "account" object would
 * let a node outage make it look as though we did not know which account we pay
 * from — which we always do.
 */
export interface PayoutAccountView {
  accountId: string;
  /** MAINNET Reed-Solomon (`S-…`): this is the chain the money actually leaves. */
  accountRS: string;
  /** Null until the first successful lookup. */
  balancePlanck: string | null;
  /** Null before the first answer; false once mainnet says it has no such account. */
  existsOnChain: boolean | null;
  /** Epoch seconds of the last SUCCESSFUL lookup, so the UI can age the balance. */
  checkedAt: number | null;
  /** Set when the most recent lookup failed; any balance beside it is stale. */
  error: string | null;
}

export interface PayoutAccountWatcher {
  /**
   * Never blocks and never throws. Returns the last known view and schedules a
   * refresh when it has gone stale.
   */
  get: () => PayoutAccountView;
}

export interface PayoutAccountDeps {
  /** Derived from PAYOUT_ACCOUNT_SEED by the caller. The seed never comes here. */
  publicKey: string;
  /** Returns undefined when mainnet has no such account. */
  getAccount: (accountId: string) => Promise<MainnetAccountResult | undefined>;
  /** How long a balance is served before another lookup is attempted. */
  ttlSeconds: number;
  now?: () => number;
}

/**
 * Tracks the payout account's mainnet balance for the admin panel.
 *
 * Refreshing is deliberately DECOUPLED from reading. The panel polls every few
 * seconds, and a mainnet lookup is a network call across a failover pool: doing
 * it inline would either hammer public nodes or hold the whole panel hostage to
 * their slowest failure. So `get()` answers instantly from cache and starts a
 * refresh in the background, which costs one poll cycle of latency on a value
 * that is measured in minutes anyway.
 *
 * Deriving the address hashes the public key, so `Crypto.init()` must have run
 * before this is constructed. It throws loudly here if not, which is the right
 * moment to find out: at boot, rather than on an operator's first page load.
 *
 * A failed lookup keeps the previous balance and reports the error alongside
 * it. Blanking the number would suggest the account had been emptied, which is
 * the one wrong conclusion an operator must not be led to.
 */
export function createPayoutAccountWatcher(deps: PayoutAccountDeps): PayoutAccountWatcher {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const address = Address.fromPublicKey(deps.publicKey, AddressPrefix.MainNet);

  let view: PayoutAccountView = {
    accountId: address.getNumericId(),
    accountRS: address.getReedSolomonAddress(),
    balancePlanck: null,
    existsOnChain: null,
    checkedAt: null,
    error: null,
  };

  // Counts attempts, not successes: without it a node outage would start a new
  // lookup on every poll, because `checkedAt` would never advance.
  let lastAttemptAt: number | null = null;
  let inFlight = false;

  async function refresh(): Promise<void> {
    inFlight = true;
    lastAttemptAt = now();
    try {
      const account = await deps.getAccount(view.accountId);
      view = {
        ...view,
        // No account on chain means no balance, and that is a real answer worth
        // showing rather than an error: it means the payout account is unfunded.
        balancePlanck: account?.balanceNQT ?? "0",
        existsOnChain: Boolean(account),
        checkedAt: now(),
        error: null,
      };
    } catch (e) {
      view = { ...view, error: describeError(e) };
    } finally {
      inFlight = false;
    }
  }

  return {
    get() {
      const stale = lastAttemptAt === null || now() - lastAttemptAt >= deps.ttlSeconds;
      if (stale && !inFlight) void refresh();
      return view;
    },
  };
}
