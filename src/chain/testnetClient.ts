import { LedgerClientFactory } from "@signumjs/core";

export interface TestnetSnapshot {
  localHeight: number;
  globalHeight: number;
  isScanning: boolean;
  lastBlockId: string;
}

export interface TestnetClient {
  getSnapshot: () => Promise<TestnetSnapshot>;
  getPeerCount: () => Promise<number>;
}

/**
 * Read-only view of the local testnet node, used by the health monitor as the
 * HTTP fallback when the SIP-50 WebSocket heartbeat stops.
 *
 * BlockchainStatus.numberOfBlocks is the local height; lastBlockchainFeederHeight
 * is the height the network claims. Their difference is the sync lag.
 */
export function createTestnetClient(nodeHost: string): TestnetClient {
  const ledger = LedgerClientFactory.createClient({ nodeHost });
  return {
    async getSnapshot() {
      const status = await ledger.network.getBlockchainStatus();
      return {
        localHeight: status.numberOfBlocks,
        globalHeight: status.lastBlockchainFeederHeight,
        isScanning: status.isScanning,
        lastBlockId: status.lastBlock,
      };
    },
    async getPeerCount() {
      const peers = await ledger.network.getPeers();
      return peers.peers.length;
    },
  };
}
