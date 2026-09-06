import { LedgerClientFactory } from "@signumjs/core";
import type { NodeBlock } from "../health/forkCheck.ts";

/**
 * Read-only view of one node's chain, used to compare histories across nodes.
 *
 * The local node is probed through this same interface: for fork detection it is
 * not privileged, it is simply one more opinion about what happened at height H.
 */
export interface BlockProbe {
  host: string;
  /** Height of the node's current head block. */
  getHeadHeight: () => Promise<number>;
  getBlockAt: (height: number) => Promise<NodeBlock>;
}

/**
 * getBlockchainStatus reports numberOfBlocks, which counts the genesis block at
 * height 0, so the head block's height is one less. Getting this wrong would
 * ask every node for a height one of them does not have yet.
 */
export function createBlockProbe(host: string): BlockProbe {
  const ledger = LedgerClientFactory.createClient({ nodeHost: host });
  return {
    host,
    async getHeadHeight() {
      const status = await ledger.network.getBlockchainStatus();
      return status.numberOfBlocks - 1;
    },
    async getBlockAt(height: number) {
      const block = await ledger.block.getBlockByHeight(height, false);
      return { blockId: block.block, generationSignature: block.generationSignature };
    },
  };
}

export function createBlockProbes(
  hosts: string[],
  makeProbe: (host: string) => BlockProbe = createBlockProbe,
): BlockProbe[] {
  return hosts.map(makeProbe);
}
