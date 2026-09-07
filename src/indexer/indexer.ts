import { ChainWalker } from "signum-chain-walker";
import type { Ledger } from "../ledger/db.ts";
import type { AppConfig } from "../config/schema.ts";
import type { MainnetAccountFacts } from "../eligibility/eligibility.ts";
import { createBlockHandler } from "./blockHandler.ts";
import { createReorgAuditor } from "./reorgAudit.ts";
import { silentLogger, describeError } from "../log.ts";
import type { Logger } from "../log.ts";

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
  log?: Logger;
}

export interface Indexer {
  /** Catches up from the configured start height, then listens. Resolves only on stop. */
  run: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * One patrol a minute. Neither half needs to be noticed in seconds: the repairs
 * are idempotent, and a payout runs every few hours.
 *
 * With the auditor's defaults that is five block reads a minute against our own
 * node, and a complete pass over the scrub window roughly every forty minutes.
 */
const CHAIN_PATROL_INTERVAL_MS = 60_000;

export function createIndexer(deps: IndexerDeps): Indexer {
  const log = deps.log ?? silentLogger();
  const handler = createBlockHandler({
    db: deps.db,
    policy: deps.config.policy,
    lookupMainnetAccount: deps.lookupMainnetAccount,
    isExcluded: deps.isExcluded,
  });

  // Set once catch-up finishes. The audit is meaningless during a replay: those
  // blocks are being read from the node's current history in the first place,
  // so re-asking the same node about them proves nothing and costs a request
  // per block.
  let live = false;
  let patrolTimer: ReturnType<typeof setInterval> | undefined;

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
    if (live) await auditSettledHeights(block.height);
    deps.onBlockObserved(block.height);
  });

  const auditor = createReorgAuditor({
    db: deps.db,
    canonicalBlockIdAt: async (height) => {
      const block = await walker.ledgerClient.block.getBlockByHeight(height, false);
      return block.block;
    },
    reindex: async (height) => {
      await handler(await walker.ledgerClient.block.getBlockByHeight(height, false));
    },
    // numberOfBlocks counts genesis at height 0, so the head block's height is
    // one less. Getting this wrong would read as a one-block rewind forever.
    nodeHeadHeight: async () => {
      const status = await walker.ledgerClient.network.getBlockchainStatus();
      return status.numberOfBlocks - 1;
    },
    resumeIndexingFrom: rewindWalkerCache,
    indexerPosition: async () => (await readWalkerCache()).lastProcessedBlock,
    // The same tolerance the fork check uses: one answer to "how deep a
    // divergence do we still consider live?", not two that can drift apart.
    depth: deps.config.health.forkCheckDepth,
    log: log.child("reorg"),
  });

  /**
   * Moves the walker's high-water mark back to a height.
   *
   * The walker keeps it in a JSON file that it re-reads at the top of every
   * cycle, which is the only seam it offers: there is no API for "you have gone
   * the wrong way". If a cycle happens to be running as this is written, that
   * cycle's own write wins and the change is lost — harmless, because the
   * rewind check runs on a timer and simply detects the same rewind again.
   */
  async function readWalkerCache(): Promise<{
    raw: Record<string, unknown>;
    lastProcessedBlock: number | undefined;
  }> {
    const file = Bun.file(deps.walkerCachePath);
    if (!(await file.exists())) return { raw: {}, lastProcessedBlock: undefined };
    const raw = (await file.json()) as Record<string, unknown>;
    const height = raw.lastProcessedBlock;
    return { raw, lastProcessedBlock: typeof height === "number" ? height : undefined };
  }

  async function rewindWalkerCache(height: number): Promise<void> {
    const { raw: cache } = await readWalkerCache();
    await Bun.write(
      deps.walkerCachePath,
      JSON.stringify({ ...cache, lastProcessedBlock: height }, null, "\t"),
    );
    log.warn("walker rewound", { toHeight: height });
  }

  /**
   * Never allowed to throw: a reorg check that fails must not take down block
   * indexing, and the walker treats a rejected handler as a processing error to
   * retry the whole block over.
   */
  async function auditSettledHeights(tipHeight: number): Promise<void> {
    try {
      await auditor.catchUpTo(tipHeight);
    } catch (e) {
      log.child("reorg").error("audit failed", { error: describeError(e) });
    }
  }

  /**
   * The two checks that cannot ride on new blocks arriving.
   *
   * A deep rewind is precisely the case where no new block arrives — the walker
   * is parked on a height the chain no longer reaches — and the scrubber looks
   * at heights that were indexed long ago, which no incoming block would ever
   * bring back into view.
   */
  async function patrolChain(): Promise<void> {
    if (!live) return;
    try {
      await auditor.checkForRewind();
      await auditor.scrub();
    } catch (e) {
      log.child("reorg").error("chain patrol failed", { error: describeError(e) });
    }
  }

  return {
    async run() {
      // walk() resumes from the cached height when it exceeds startHeight, so a
      // restart continues where it left off rather than replaying everything.
      await walker.walk(deps.config.chain.startHeight);
      live = true;
      deps.onCaughtUp?.();
      patrolTimer = setInterval(() => void patrolChain(), CHAIN_PATROL_INTERVAL_MS);
      await walker.listen();
    },
    async stop() {
      if (patrolTimer) clearInterval(patrolTimer);
      patrolTimer = undefined;
      await walker.stop();
    },
  };
}
