import { LedgerClientFactory, type TransactionId } from "@signumjs/core";
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

export interface SendSingleArgs extends UnsignedSendArgs {
  senderPrivateKey: string
}
export interface SendMultiOutArgs extends UnsignedMultiOutArgs {
  senderPrivateKey: string
}

/**
 * What a node knows about one transaction.
 *
 * The three cases are the node's three genuine answers, mapped once here so no
 * caller has to reason about an absent `confirmations` field or an error code:
 *
 *  - `mempool`   accepted, not yet in a block. GetTransaction.java falls through
 *                to the unconfirmed pool and returns it WITHOUT a confirmations
 *                field, so undefined means "in flight", not "zero confirmations".
 *  - `confirmed` in a block. `confirmations` is height - txHeight, so a
 *                transaction in the head block reads 0, not 1.
 *  - `unknown`   errorCode 5. Says only that THIS node has no record of it, and
 *                its mempool is in-memory and evicts under load, so it is not
 *                by itself evidence the transaction is dead.
 */
export type TransactionLookup =
  | { kind: "unknown" }
  | { kind: "mempool" }
  | { kind: "confirmed"; confirmations: number; height: number };

export interface SendResult {
  transaction: TransactionId;
  /** The node that accepted it. Confirmation polling MUST be pinned here. */
  host: string;
}

/** The narrow slice of a ledger client this pool needs. Injectable for tests. */
export interface MainnetNodeClient {
  getAccount: (accountId: string) => Promise<MainnetAccountResult>;
  buildUnsignedMultiOut: (args: UnsignedMultiOutArgs) => Promise<UnsignedTransaction>;
  buildUnsignedSend: (args: UnsignedSendArgs) => Promise<UnsignedTransaction>;
  sendMultiOut: (args: SendMultiOutArgs) => Promise<TransactionId>;
  sendSingle: (args: SendSingleArgs) => Promise<TransactionId>;
  getTransaction: (transactionId: string) => Promise<TransactionLookup>;
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
  /**
   * Signs and broadcasts a payout. NEVER retried and NEVER failed over.
   *
   * SignumJS makes two calls here: the node builds the unsigned transaction,
   * then the signed bytes are broadcast. The node stamps the transaction with
   * its own clock -- `int timestamp = timeService.getEpochTime()` in
   * TransactionProcessorImpl -- so a rebuild produces DIFFERENT bytes and a
   * different transaction id. If the broadcast succeeded but its response was
   * lost, retrying anywhere would put a second, equally valid payout on the
   * chain and pay everyone twice.
   *
   * So the contract is: one attempt, one node, and a rejection is resolved by
   * asking the chain what happened -- never by sending again.
   */
  sendMultiOut: (args: SendMultiOutArgs) => Promise<SendResult>;
  /** Same contract as sendMultiOut: one attempt, no failover. */
  sendSingle: (args: SendSingleArgs) => Promise<SendResult>;
  /**
   * Looks one transaction up on ONE named host.
   *
   * Read-only, but deliberately not failed over: which node is answering is the
   * whole point. A node that never saw the transaction reports `unknown`, and
   * treating that as "it is gone" would release accruals that are still live.
   */
  getTransaction: (host: string, transactionId: string) => Promise<TransactionLookup>;
  /** Hosts in preference order, so a caller can pick a different one to re-ask. */
  hosts: string[];
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

/**
 * errorCode 5 is signum-node's "Unknown transaction" (JSONResponses.unknown).
 * Matched EXACTLY rather than "any errorCode", because errorCode 4 is
 * "Incorrect ..." -- a malformed request, not a missing transaction, and
 * mistaking one for the other would release a batch that is still in flight.
 */
function isUnknownTransaction(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "data" in e &&
    typeof (e as { data?: unknown }).data === "object" &&
    (e as { data?: { errorCode?: unknown } }).data?.errorCode === 5
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

    // NOT withFailover. See the interface: a retry rebuilds the transaction at a
    // new node-assigned timestamp, which is a second valid payout rather than a
    // repeat of the first. A throw here means "unknown outcome", and the caller
    // resolves it by reading the chain.
    async sendMultiOut(args) {
      const host = hosts[preferred]!;
      return { transaction: await clients[preferred]!.sendMultiOut(args), host };
    },
    async sendSingle(args) {
      const host = hosts[preferred]!;
      return { transaction: await clients[preferred]!.sendSingle(args), host };
    },

    async getTransaction(host: string, transactionId: string) {
      const index = hosts.indexOf(host);
      const client = index === -1 ? undefined : clients[index];
      if (!client) throw new Error(`No mainnet client for host ${host}`);
      try {
        return await client.getTransaction(transactionId);
      } catch (e) {
        if (isUnknownTransaction(e)) return { kind: "unknown" as const };
        throw e;
      }
    },

    hosts: [...hosts],
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
    sendMultiOut: async (args) =>
        (await ledger.transaction.sendAmountToMultipleRecipients({
          recipientAmounts: args.recipientAmounts,
          senderPublicKey: args.senderPublicKey,
          senderPrivateKey: args.senderPrivateKey,
          feePlanck: args.feePlanck,
          deadline: args.deadline,
        })) as TransactionId,
    sendSingle: async (args) =>
      (await ledger.transaction.sendAmountToSingleRecipient({
        recipientId: args.recipientId,
        amountPlanck: args.amountPlanck,
        senderPublicKey: args.senderPublicKey,
        senderPrivateKey: args.senderPrivateKey,
        feePlanck: args.feePlanck,
        deadline: args.deadline,
      })) as TransactionId,
    // BY ID, never by full hash: GetTransaction.java only falls through to the
    // unconfirmed pool on the id branch. Looking up by full hash reports a
    // transaction still sitting in the mempool as unknown.
    getTransaction: async (transactionId: string) => {
      const tx = await ledger.transaction.getTransaction(transactionId);
      return tx.confirmations === undefined
        ? { kind: "mempool" as const }
        : { kind: "confirmed" as const, confirmations: tx.confirmations, height: tx.height };
    },
  };
}
