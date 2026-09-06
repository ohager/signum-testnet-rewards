import { LedgerClientFactory } from "@signumjs/core";
import type { UnsignedTransaction } from "@signumjs/core";
import { ChainTime } from "@signumjs/util";

export interface TestnetSnapshot {
  localHeight: number;
  globalHeight: number;
  isScanning: boolean;
  lastBlockId: string;
}

/** The node's current head block, as an operator would want to read it. */
export interface HeadBlock {
  height: number;
  blockId: string;
  generationSignature: string;
  /** Numeric account id of the forger. */
  generatorId: string;
  /** Reed-Solomon address of the forger — the form a human recognises. */
  generatorRS: string;
  /** Epoch seconds. Converted here so nothing downstream handles chain time. */
  forgedAt: number;
}

export interface TestnetClient {
  getSnapshot: () => Promise<TestnetSnapshot>;
  getPeerCount: () => Promise<number>;
  /**
   * Builds a multi-out payment WITHOUT signing or broadcasting it.
   *
   * No private key is passed, which is precisely what makes the node return
   * unsigned bytes instead of spending anything.
   */
  buildUnsignedMultiOut: (args: {
    recipientAmounts: { recipient: string; amountNQT: string }[];
    senderPublicKey: string;
    feePlanck: string;
    deadline: number;
  }) => Promise<UnsignedTransaction>;
  /** The single-recipient fallback: signum-node rejects multi-out below two recipients. */
  buildUnsignedSend: (args: {
    recipientId: string;
    amountPlanck: string;
    senderPublicKey: string;
    feePlanck: string;
    deadline: number;
  }) => Promise<UnsignedTransaction>;
  /** Resolves the head block named by a snapshot, so both describe the same moment. */
  getHeadBlock: (blockId: string) => Promise<HeadBlock>;
}

/**
 * Read-only view of the local testnet node, used by the health monitor as the
 * HTTP fallback when the SIP-50 WebSocket heartbeat stops.
 *
 * BlockchainStatus.numberOfBlocks COUNTS blocks including genesis at height 0,
 * so the head block's height is one less. lastBlockchainFeederHeight is a real
 * height, so the subtraction is also what makes the sync-lag comparison compare
 * like with like.
 */
export function createTestnetClient(nodeHost: string): TestnetClient {
  const ledger = LedgerClientFactory.createClient({ nodeHost });
  return {
    async getSnapshot() {
      const status = await ledger.network.getBlockchainStatus();
      return {
        localHeight: status.numberOfBlocks - 1,
        globalHeight: status.lastBlockchainFeederHeight,
        isScanning: status.isScanning,
        lastBlockId: status.lastBlock,
      };
    },
    async getPeerCount() {
      const peers = await ledger.network.getPeers();
      return peers.peers.length;
    },
    async buildUnsignedMultiOut(args) {
      return (await ledger.transaction.sendAmountToMultipleRecipients({
        recipientAmounts: args.recipientAmounts,
        senderPublicKey: args.senderPublicKey,
        feePlanck: args.feePlanck,
        deadline: args.deadline,
      })) as UnsignedTransaction;
    },
    async buildUnsignedSend(args) {
      return (await ledger.transaction.sendAmountToSingleRecipient({
        recipientId: args.recipientId,
        amountPlanck: args.amountPlanck,
        senderPublicKey: args.senderPublicKey,
        feePlanck: args.feePlanck,
        deadline: args.deadline,
      })) as UnsignedTransaction;
    },
    async getHeadBlock(blockId: string) {
      // Fetched BY ID rather than by height: the snapshot already named the head,
      // and asking again by height could return a different block if one arrived
      // in between, quietly reporting a height and a forger that disagree.
      const block = await ledger.block.getBlockById(blockId, false);
      return {
        height: block.height,
        blockId: block.block,
        generationSignature: block.generationSignature,
        generatorId: block.generator,
        generatorRS: block.generatorRS,
        // getEpoch() returns MILLISECONDS despite its name and its docstring;
        // getDate() is the unambiguous route to seconds.
        forgedAt: Math.floor(ChainTime.fromChainTimestamp(block.timestamp).getDate().getTime() / 1000),
      };
    },
  };
}
