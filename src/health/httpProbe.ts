import type { TestnetClient } from "../chain/testnetClient.ts";

export interface ProbeResult {
  httpReachable: boolean;
  localHeight: number | undefined;
  globalHeight: number | undefined;
  peerCount: number | undefined;
  /** Set when the height advanced since the previous probe. */
  blockAdvancedAtMs: number | undefined;
}

/**
 * Polls the testnet node over HTTP.
 *
 * This is what keeps `testnet_stalled` detectable when the SIP-50 socket is
 * dead: by tracking height changes between probes it supplies the block timing
 * the WebSocket would otherwise have provided.
 */
export function createHttpProbe(client: TestnetClient, now: () => number = Date.now) {
  let lastSeenHeight: number | undefined;

  return async function probe(): Promise<ProbeResult> {
    try {
      const snapshot = await client.getSnapshot();
      let blockAdvancedAtMs: number | undefined;
      if (lastSeenHeight !== undefined && snapshot.localHeight > lastSeenHeight) {
        blockAdvancedAtMs = now();
      }
      lastSeenHeight = snapshot.localHeight;

      let peerCount: number | undefined;
      try {
        peerCount = await client.getPeerCount();
      } catch {
        // Peers failing alone is not "node unreachable".
        peerCount = undefined;
      }

      return {
        httpReachable: true,
        localHeight: snapshot.localHeight,
        globalHeight: snapshot.globalHeight,
        peerCount,
        blockAdvancedAtMs,
      };
    } catch {
      return {
        httpReachable: false,
        localHeight: undefined,
        globalHeight: undefined,
        peerCount: undefined,
        blockAdvancedAtMs: undefined,
      };
    }
  };
}
