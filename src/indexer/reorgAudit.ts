import type { Ledger } from "../ledger/db.ts";
import {
  activeBlockRewardsAtHeight,
  markBlockOrphaned,
  lastIndexedBlock,
  activeBlockRewardsAbove,
} from "../ledger/blockRewards.ts";
import {
  getReorgAuditHeight,
  setReorgAuditHeight,
  tripKillSwitch,
  recordChainHalt,
} from "../ledger/state.ts";
import { openAlert, recordNotice } from "../ledger/alerts.ts";
import { silentLogger, describeError } from "../log.ts";
import type { Logger } from "../log.ts";

export interface ReorgAuditDeps {
  db: Ledger;
  /** The block id our own node currently reports at a height. */
  canonicalBlockIdAt: (height: number) => Promise<string>;
  /** Re-scores a height from the canonical block, through the normal handler. */
  reindex: (height: number) => Promise<void>;
  /** Head height our own node currently reports. */
  nodeHeadHeight: () => Promise<number>;
  /**
   * The height the block walker will continue from. Read separately from the
   * ledger because it is the thing that actually gets stuck: the walker can be
   * parked on a discarded height with nothing in the ledger to show for it.
   */
  indexerPosition: () => Promise<number | undefined>;
  /**
   * Points the block walker at a height, so indexing resumes there.
   *
   * Needed because the walker only ever moves forward: after a rewind it sits
   * waiting for a block that will never be mined at that height, and on a deep
   * pop that is hours of not indexing anything.
   */
  resumeIndexingFrom: (height: number) => Promise<void>;
  /**
   * How far behind the indexer's tip a height is verified. A reorg deeper than
   * this is missed, so it is the same tolerance the fork check declares.
   */
  depth: number;
  /**
   * Ceiling on how many heights one call will verify. A restart after a long
   * outage must not turn into thousands of node requests before the service
   * indexes anything; the sweep gives up the oldest heights instead.
   */
  maxBacklog?: number;
  /**
   * How far back the scrubber keeps re-checking heights it has already
   * verified. Sized by how deep this chain actually rewrites itself, not by
   * what a chain is supposed to do.
   */
  scrubWindow?: number;
  /** Heights the scrubber re-checks per pass. One node request each. */
  scrubBatch?: number;
  /**
   * How long rolled-back heights are gathered up before they are reported.
   *
   * A reorg is a burst, not an event: repairing one produced fifty-seven
   * rollbacks in a single pass against real data. Fifty-seven notifications for
   * one incident is the failure this service has already been bitten by once.
   */
  rollbackNoticeWindowMs?: number;
  log?: Logger;
  now?: () => number;
}

export type ReorgAuditOutcome =
  /** Nothing could be concluded. Never treated as evidence of a reorg. */
  | { kind: "unchecked"; height: number; reason: string }
  | { kind: "intact"; height: number }
  | {
      kind: "reorged";
      height: number;
      canonicalBlockId: string;
      /** Block ids whose accrual was rolled back. */
      orphaned: string[];
      /** Of those, the ones already committed to a payout batch. */
      paid: string[];
    };

export type RewindOutcome =
  | { kind: "none" }
  | { kind: "unchecked"; reason: string }
  | {
      kind: "rewound";
      /** The head the node reports now. */
      head: number;
      /** The height we had indexed up to before it vanished. */
      previousTip: number;
      orphaned: string[];
      paid: string[];
    };

export interface ReorgAuditor {
  /**
   * Verifies everything that has become settled now that `tipHeight` is
   * indexed. Usually one height; more only after a gap.
   */
  catchUpTo: (tipHeight: number) => Promise<ReorgAuditOutcome[]>;
  /** Verifies one height. Exposed for the admin path and for tests. */
  auditHeight: (height: number) => Promise<ReorgAuditOutcome>;
  /**
   * Detects a node that has discarded blocks we already indexed, and repairs
   * what that leaves behind. Runs on a timer, NOT on new blocks: a deep rewind
   * is exactly the situation where no new block arrives for a long time.
   */
  checkForRewind: () => Promise<RewindOutcome>;
  /**
   * Reports any gathered rollbacks now rather than at the end of their window.
   * For a one-off repair run, which exits before the next patrol.
   */
  flushNotices: () => void;
  /**
   * Re-checks a rotating slice of heights the forward sweep has already
   * settled. Catches the case neither other mechanism can: a branch swapped in
   * long after we verified those heights, leaving the head no lower than
   * before.
   */
  scrub: () => Promise<ReorgAuditOutcome[]>;
  /** The highest height verified so far, from the ledger. */
  verifiedHeight: () => number | undefined;
}

/**
 * Re-checks settled blocks against the node that reported them.
 *
 * This exists because nothing else in the pipeline can see a reorg. The chain
 * walker advances a high-water mark and never looks back, and block_rewards is
 * keyed by block id — so when a branch is replaced, the losing block keeps its
 * row, keeps counting against the daily caps, and stays payable, while the
 * block that actually won at that height is never visited at all. Both halves
 * of that are wrong, and both are invisible without asking the node again.
 *
 * It is deliberately separate from fork detection. A fork is a disagreement
 * with OTHER nodes; a reorg is our own node changing its mind, which it does
 * routinely and without anybody disagreeing with anybody. The fork monitor
 * would never see it.
 *
 * Verification trails the tip by `depth` so that ordinary short reorgs are
 * absorbed before we act on them: re-scoring a height that is about to change
 * again would churn accruals for no reason.
 */
export function createReorgAuditor(deps: ReorgAuditDeps): ReorgAuditor {
  const log = deps.log ?? silentLogger();
  const now = deps.now ?? Date.now;
  const maxBacklog = deps.maxBacklog ?? 100;
  const scrubWindow = deps.scrubWindow ?? 200;
  const scrubBatch = deps.scrubBatch ?? 5;
  /** Where the rotation is. In memory: a restart simply starts the pass again. */
  let scrubCursor: number | undefined;
  const rollbackWindowMs = deps.rollbackNoticeWindowMs ?? 15 * 60_000;
  /** Rolled-back heights waiting to be reported as one notice. */
  let pendingRollback: { count: number; lowest: number; highest: number; sinceMs: number } | undefined;

  async function auditHeight(height: number): Promise<ReorgAuditOutcome> {
    if (height < 0) return { kind: "unchecked", height, reason: "height below genesis" };

    const recorded = activeBlockRewardsAtHeight(deps.db, height);
    if (recorded.length === 0) {
      // Nothing of ours is at risk here, so the height counts as verified: an
      // unindexed height must not stall the watermark behind it forever.
      return { kind: "intact", height };
    }

    let canonicalBlockId: string;
    try {
      canonicalBlockId = await deps.canonicalBlockIdAt(height);
    } catch (e) {
      // A node that will not answer is an observation we do not have. Rolling
      // back real accruals on the strength of a failed HTTP call would be the
      // worst possible reading of silence.
      return { kind: "unchecked", height, reason: describeError(e) };
    }

    const stale = recorded.filter((row) => row.blockId !== canonicalBlockId);
    if (stale.length === 0) return { kind: "intact", height };

    const at = Math.floor(now() / 1000);
    const orphaned: string[] = [];
    const paid: string[] = [];
    for (const row of stale) {
      if (!markBlockOrphaned(deps.db, row.blockId, at)) continue;
      orphaned.push(row.blockId);
      if (row.batchId !== null) paid.push(row.blockId);
    }

    // Re-scored through the normal handler, so the replacement block earns
    // under the caps as they stand now — including the room the rollback just
    // gave back.
    await deps.reindex(height);

    // Reported HERE rather than by each caller. Every repair goes through this
    // function, and the one-off repair tool calls it directly: with the
    // reporting left to the callers, that tool rolled back forty-four accruals
    // in complete silence, and would have rolled back a paid one without
    // raising the incident or stopping the money.
    const outcome: ReorgAuditOutcome = { kind: "reorged", height, canonicalBlockId, orphaned, paid };
    report(outcome);
    return outcome;
  }

  async function catchUpTo(tipHeight: number): Promise<ReorgAuditOutcome[]> {
    const target = tipHeight - deps.depth;
    if (target < 0) return [];

    const verified = getReorgAuditHeight(deps.db);
    const from = Math.max(verified === undefined ? target : verified + 1, target - maxBacklog + 1);
    if (from > target) return [];
    if (verified !== undefined && from > verified + 1) {
      log.warn("reorg audit backlog too large; skipping the oldest heights", {
        verified,
        resumingAt: from,
      });
    }

    const outcomes: ReorgAuditOutcome[] = [];
    for (let height = from; height <= target; height++) {
      const outcome = await auditHeight(height);
      outcomes.push(outcome);
      // The watermark advances only past heights we actually verified. An
      // unreachable node leaves it where it is, and the next tick retries.
      if (outcome.kind === "unchecked") {
        log.debug("reorg audit skipped a height", { height, reason: outcome.reason });
        break;
      }
      setReorgAuditHeight(deps.db, height);
    }
    flushRollbackNotice();
    return outcomes;
  }

  /**
   * Handles the case the tail sweep structurally cannot: blocks that are gone
   * rather than replaced.
   *
   * The sweep compares a height against what the node has AT that height, so it
   * can only speak about heights the node still reaches. When a node pops a
   * hundred blocks there is nothing at those heights to compare against, and
   * the walker — which only ever asks for lastProcessed + 1 — parks itself on a
   * block that will not exist again for hours. Both halves are repaired here:
   * everything above the new head is rolled back, and the walker is pointed at
   * the head so it indexes the branch that won.
   */
  async function checkForRewind(): Promise<RewindOutcome> {
    let head: number;
    let walkerPosition: number | undefined;
    try {
      head = await deps.nodeHeadHeight();
      walkerPosition = await deps.indexerPosition();
    } catch (e) {
      return { kind: "unchecked", reason: describeError(e) };
    }

    // The furthest forward anything here believes the chain to be. Both halves
    // matter: the ledger says what we would pay out on, the walker says what we
    // are waiting for, and a rewind can leave either one stranded on its own.
    const tip = Math.max(lastIndexedBlock(deps.db)?.height ?? -1, walkerPosition ?? -1);
    if (tip < 0 || head >= tip) return { kind: "none" };

    const at = Math.floor(now() / 1000);
    const orphaned: string[] = [];
    const paid: string[] = [];
    for (const row of activeBlockRewardsAbove(deps.db, head)) {
      if (!markBlockOrphaned(deps.db, row.blockId, at)) continue;
      orphaned.push(row.blockId);
      if (row.batchId !== null) paid.push(row.blockId);
    }

    // Resumed AT the head rather than below it: the heights underneath still
    // have live rows, and re-walking them would record the winning branch's
    // blocks as SECOND accruals at heights whose losers have not been rolled
    // back yet. Those heights belong to the sweep, which orphans before it
    // re-scores.
    await deps.resumeIndexingFrom(head);

    // The divergence can reach below the new head, so the sweep is sent back a
    // tolerance's worth of blocks to re-verify what it had already passed.
    const verified = getReorgAuditHeight(deps.db);
    const resumeAudit = head - deps.depth;
    if (verified === undefined || resumeAudit < verified) {
      setReorgAuditHeight(deps.db, Math.max(resumeAudit, 0));
    }

    const outcome: RewindOutcome = { kind: "rewound", head, previousTip: tip, orphaned, paid };
    // A repair with nothing to roll back is this check re-issuing a walker
    // rewind whose file write was overwritten by the walker's own cycle. That
    // is worth a log line and nothing else: alerting once a minute for as long
    // as it takes to stick would bury the alert that mattered.
    if (orphaned.length > 0) reportRewind(outcome);
    else log.warn("re-pointed the walker at the chain head", { head, from: tip });
    return outcome;
  }

  function reportRewind(outcome: Extract<RewindOutcome, { kind: "rewound" }>): void {
    const lost = outcome.previousTip - outcome.head;
    const summary =
      `Chain rewind: our node dropped back from height ${outcome.previousTip} to ` +
      `${outcome.head}, discarding ${lost} block(s). ${outcome.orphaned.length} recorded ` +
      `accrual(s) above the new head were rolled back and indexing resumed at ${outcome.head}`;

    if (outcome.paid.length > 0) {
      const message =
        `${summary}. ${outcome.paid.length} of them were already committed to a payout batch ` +
        `(${outcome.paid.join(", ")}), so real SIGNA was released for work that is no longer on ` +
        `the chain. Payouts are halted pending review.`;
      log.error("a rewind invalidated an already-paid accrual", {
        head: outcome.head,
        blocks: outcome.paid.join(", "),
      });
      openAlert(deps.db, { kind: "reorg_paid_accrual", severity: "critical", message });
      tripKillSwitch(deps.db, message);
      recordChainHalt(deps.db, { height: outcome.previousTip, cause: "rewind" });
      return;
    }

    log.warn("chain rewind repaired", { head: outcome.head, dropped: lost });

    if (lost > deps.depth) {
      // Beyond the depth this service says it tolerates. Nothing was paid, so
      // nothing is lost — but a chain that discards this much is not a chain to
      // be releasing money on, and the halt lifts itself once the branch that
      // won has been rebuilt past here and verified block by block.
      const message =
        `${summary}, which is deeper than the ${deps.depth}-block tolerance. Payouts are ` +
        `halted until the chain has been rebuilt and re-verified past height ${outcome.previousTip}.`;
      openAlert(deps.db, { kind: "chain_rewound", severity: "critical", message });
      tripKillSwitch(deps.db, message);
      recordChainHalt(deps.db, { height: outcome.previousTip, cause: "rewind" });
      return;
    }

    recordNotice(deps.db, {
      kind: "chain_rewound",
      severity: "warning",
      message: `${summary}. The accruals were unpaid, so they were rolled back.`,
    });
  }

  /**
   * Re-verifies heights that were already verified once.
   *
   * The forward sweep checks each height exactly once, `depth` blocks after it
   * was indexed, and never returns to it. That is a real hole, and not a
   * theoretical one: this chain has been observed replacing blocks eighty-odd
   * deep, in runs interleaved with blocks that survived, and by the time we
   * could look the head was no lower than before — invisible to the sweep,
   * which had moved on, and to the rewind check, which had nothing to see.
   *
   * So a slice of the recent past is re-read on every pass, rotating. It offers
   * no guarantee, just a bounded time to notice: the whole window is covered
   * every `scrubWindow / scrubBatch` passes. Cheap enough to keep permanently
   * on — a handful of block reads a minute against our own node.
   *
   * A height that cannot be read is skipped rather than retried, unlike in the
   * sweep. There is no watermark here to keep honest, and the rotation will be
   * back round soon enough.
   */
  async function scrub(): Promise<ReorgAuditOutcome[]> {
    const tip = lastIndexedBlock(deps.db)?.height;
    if (tip === undefined) return [];

    // Anything newer than this belongs to the forward sweep, which has not
    // settled it yet. Checking it here would only duplicate that work.
    const newest = tip - deps.depth;
    if (newest < 0) return [];
    const oldest = Math.max(newest - scrubWindow + 1, 0);
    if (scrubCursor === undefined || scrubCursor < oldest || scrubCursor > newest) {
      scrubCursor = oldest;
    }

    const outcomes: ReorgAuditOutcome[] = [];
    for (let n = 0; n < scrubBatch && scrubCursor <= newest; n++) {
      const outcome = await auditHeight(scrubCursor);
      scrubCursor++;
      outcomes.push(outcome);
      if (outcome.kind === "reorged") {
        log.warn("scrubber found a replaced block below the swept range", {
          height: outcome.height,
        });
      }
    }
    flushRollbackNotice();
    return outcomes;
  }

  function report(outcome: Extract<ReorgAuditOutcome, { kind: "reorged" }>): void {
    const summary =
      `Reorg at height ${outcome.height}: ${outcome.orphaned.length} recorded block(s) ` +
      `replaced by ${outcome.canonicalBlockId}`;

    if (outcome.paid.length > 0) {
      // Money has already left for a block that no longer exists. Nothing here
      // can unwind that, so it stops the next payout and asks for a human —
      // the same standard as a confirmed fork, for the same reason.
      const message =
        `${summary}. ${outcome.paid.length} of them were already committed to a payout batch ` +
        `(${outcome.paid.join(", ")}), so real SIGNA was released for work that is no longer ` +
        `on the chain. Payouts are halted pending review.`;
      log.error("reorg invalidated an already-paid accrual", {
        height: outcome.height,
        blocks: outcome.paid.join(", "),
      });
      openAlert(deps.db, { kind: "reorg_paid_accrual", severity: "critical", message });
      tripKillSwitch(deps.db, message);
      recordChainHalt(deps.db, { height: outcome.height, cause: "rewind" });
      return;
    }

    // Nothing was paid, so the rollback is complete and there is nothing to
    // decide: a notice rather than an open incident — and one notice for the
    // whole burst, not one per height.
    log.warn("reorg rolled back an accrual", {
      height: outcome.height,
      blocks: outcome.orphaned.join(", "),
    });
    pendingRollback = {
      count: (pendingRollback?.count ?? 0) + outcome.orphaned.length,
      lowest: Math.min(pendingRollback?.lowest ?? outcome.height, outcome.height),
      highest: Math.max(pendingRollback?.highest ?? outcome.height, outcome.height),
      sinceMs: pendingRollback?.sinceMs ?? now(),
    };
  }

  /**
   * Reports gathered rollbacks as a single notice.
   *
   * Called on every patrol, so the window is the longest anyone waits to hear
   * about it; `force` is for a one-off repair run, which would otherwise exit
   * with the summary still in hand.
   */
  function flushRollbackNotice(force = false): void {
    const pending = pendingRollback;
    if (!pending) return;
    if (!force && now() - pending.sinceMs < rollbackWindowMs) return;
    pendingRollback = undefined;

    const where =
      pending.lowest === pending.highest
        ? `at height ${pending.lowest}`
        : `between heights ${pending.lowest} and ${pending.highest}`;
    recordNotice(deps.db, {
      kind: "reorg_rolled_back",
      severity: "warning",
      message:
        `${pending.count} block(s) ${where} were replaced by a reorg. The accruals were ` +
        `unpaid, so they were rolled back and those heights re-scored from the chain.`,
    });
  }

  return {
    catchUpTo,
    auditHeight,
    checkForRewind,
    scrub,
    flushNotices: () => flushRollbackNotice(true),
    verifiedHeight: () => getReorgAuditHeight(deps.db),
  };
}
