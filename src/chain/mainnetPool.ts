import { LedgerClientFactory } from "@signumjs/core";

export interface MainnetAccountResult {
  account: string;
  publicKey: string | null;
  balanceNQT: string;
}

/** The narrow slice of a ledger client this pool needs. Injectable for tests. */
export interface MainnetNodeClient {
  getAccount: (accountId: string) => Promise<MainnetAccountResult>;
}

export class AllNodesFailedError extends Error {
  constructor(hosts: string[], lastError: unknown) {
    super(`All mainnet nodes failed (${hosts.join(", ")}): ${String(lastError)}`);
    this.name = "AllNodesFailedError";
  }
}

export interface MainnetPool {
  /** Returns undefined when the account does not exist on mainnet. */
  getAccount: (accountId: string) => Promise<MainnetAccountResult | undefined>;
}

/**
 * A node error carrying an errorCode means the node answered and said "no such
 * account". That is a real answer, not a node failure, so it must not trigger
 * failover: otherwise every lookup for an unregistered miner would walk the
 * whole pool and then throw.
 */
function isAccountNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "data" in e &&
    typeof (e as { data?: unknown }).data === "object" &&
    (e as { data?: { errorCode?: unknown } }).data?.errorCode !== undefined
  );
}

export function createMainnetPool(
  hosts: string[],
  makeClient: (host: string) => MainnetNodeClient = defaultClientFactory,
): MainnetPool {
  const clients = hosts.map(makeClient);
  // Index of the node that most recently worked; failover starts from here.
  let preferred = 0;

  async function withFailover<T>(fn: (client: MainnetNodeClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < clients.length; attempt++) {
      const index = (preferred + attempt) % clients.length;
      const client = clients[index];
      if (!client) continue;
      try {
        const result = await fn(client);
        preferred = index;
        return result;
      } catch (e) {
        if (isAccountNotFound(e)) {
          preferred = index;
          throw e;
        }
        lastError = e;
      }
    }
    throw new AllNodesFailedError(hosts, lastError);
  }

  return {
    async getAccount(accountId: string) {
      try {
        return await withFailover((c) => c.getAccount(accountId));
      } catch (e) {
        if (isAccountNotFound(e)) return undefined;
        throw e;
      }
    },
  };
}

function defaultClientFactory(host: string): MainnetNodeClient {
  const ledger = LedgerClientFactory.createClient({ nodeHost: host });
  return {
    getAccount: async (accountId: string) => {
      const account = await ledger.account.getAccount({ accountId });
      return {
        account: account.account,
        publicKey: account.publicKey || null,
        balanceNQT: account.balanceNQT,
      };
    },
  };
}
