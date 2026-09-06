import { LedgerClientFactory } from "@signumjs/core";
import type { UnsignedTransaction } from "@signumjs/core";

export interface UnsignedMultiOutArgs {
  recipientAmounts: { recipient: string; amountNQT: string }[];
  senderPublicKey: string;
  feePlanck: string;
  deadline: number;
}

export interface UnsignedSendArgs {
  recipientId: string;
  amountPlanck: string;
  senderPublicKey: string;
  feePlanck: string;
  deadline: number;
}

export interface MainnetAccountResult {
  account: string;
  publicKey: string | null;
  balanceNQT: string;
}

/** The narrow slice of a ledger client this pool needs. Injectable for tests. */
export interface MainnetNodeClient {
  getAccount: (accountId: string) => Promise<MainnetAccountResult>;
  buildUnsignedMultiOut: (args: UnsignedMultiOutArgs) => Promise<UnsignedTransaction>;
  buildUnsignedSend: (args: UnsignedSendArgs) => Promise<UnsignedTransaction>;
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
  /**
   * Builds a payout WITHOUT signing or broadcasting it.
   *
   * Payouts live on MAINNET: miners forge on testnet, but the reward is real
   * SIGNA, which is the whole reason eligibility requires an active mainnet
   * account. Building this against the testnet node would model a transaction
   * in a currency nobody wants.
   *
   * Failover is safe here precisely because no private key is passed: the call
   * has no side effect, so retrying it on the next node cannot pay twice.
   */
  buildUnsignedMultiOut: (args: UnsignedMultiOutArgs) => Promise<UnsignedTransaction>;
  /** The single-recipient fallback: signum-node rejects multi-out below two recipients. */
  buildUnsignedSend: (args: UnsignedSendArgs) => Promise<UnsignedTransaction>;
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
    buildUnsignedMultiOut: (args) => withFailover((c) => c.buildUnsignedMultiOut(args)),
    buildUnsignedSend: (args) => withFailover((c) => c.buildUnsignedSend(args)),
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
    // No senderPrivateKey is passed, so SignumJS returns unsigned bytes instead
    // of broadcasting. That omission is the entire safety mechanism.
    buildUnsignedMultiOut: async (args) =>
      (await ledger.transaction.sendAmountToMultipleRecipients({
        recipientAmounts: args.recipientAmounts,
        senderPublicKey: args.senderPublicKey,
        feePlanck: args.feePlanck,
        deadline: args.deadline,
      })) as UnsignedTransaction,
    buildUnsignedSend: async (args) =>
      (await ledger.transaction.sendAmountToSingleRecipient({
        recipientId: args.recipientId,
        amountPlanck: args.amountPlanck,
        senderPublicKey: args.senderPublicKey,
        feePlanck: args.feePlanck,
        deadline: args.deadline,
      })) as UnsignedTransaction,
  };
}
