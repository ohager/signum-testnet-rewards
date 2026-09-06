import { ChainWalker } from "signum-chain-walker";
import type { Ledger } from "../ledger/db.ts";
import type { AppConfig } from "../config/schema.ts";
import type { MainnetAccountFacts } from "../eligibility/eligibility.ts";
import { createBlockHandler } from "./blockHandler.ts";

export interface IndexerDeps {
  db: Ledger;
  config: AppConfig;
  walkerCachePath: string;
  lookupMainnetAccount: (accountId: string) => Promise<MainnetAccountFacts | undefined>;
  isExcluded: (accountId: string) => boolean;
  onBlockObserved: (height: number) => void;
  /**
   * Fired once, when catch-up finishes and the walker goes live.
   *
   * onBlock fires for replayed history too, so anything that must not act on
   * old blocks -- paying money, above all -- gates on this instead.
   */
  onCaughtUp?: () => void;
}

export interface Indexer {
  /** Catches up from the configured start height, then listens. Resolves only on stop. */
  run: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createIndexer(deps: IndexerDeps): Indexer {
  const handler = createBlockHandler({
    db: deps.db,
    policy: deps.config.policy,
    lookupMainnetAccount: deps.lookupMainnetAccount,
    isExcluded: deps.isExcluded,
  });

  const walker = new ChainWalker({
    nodeHost: deps.config.chain.testnetNodeHost,
    cachePath: deps.walkerCachePath,
    intervalSeconds: deps.config.chain.walkerIntervalSeconds,
    blockOffset: deps.config.chain.blockOffset,
    // The walker logs a line per block, so this is the difference between a
    // readable log and a wall of text once it is caught up.
    verbose: deps.config.verboseLogging,
  }).onBlock(async (block) => {
    await handler(block);
    deps.onBlockObserved(block.height);
  });

  return {
    async run() {
      // walk() resumes from the cached height when it exceeds startHeight, so a
      // restart continues where it left off rather than replaying everything.
      await walker.walk(deps.config.chain.startHeight);
      deps.onCaughtUp?.();
      await walker.listen();
    },
    async stop() {
      await walker.stop();
    },
  };
}
