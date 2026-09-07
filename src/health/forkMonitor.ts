import type { Ledger } from "../ledger/db.ts";
import type { BlockProbe } from "../chain/blockProbe.ts";
import { compareChains, chooseComparisonHeight } from "./forkCheck.ts";
import type { ForkComparison, NodeBlock, ReferenceObservation } from "./forkCheck.ts";
import { recordForkObservation } from "../ledger/forkObservations.ts";

export interface ForkMonitorDeps {
  db: Ledger;
  /** Our own node. For this comparison it is not privileged, just one opinion. */
  local: BlockProbe;
  references: BlockProbe[];
  /** Blocks to step back from the lowest height, absorbing propagation skew and short reorgs. */
  depth: number;
  intervalMs: number;
  /** Consecutive rounds a verdict must repeat before it is reported as confirmed. */
  confirmRounds: number;
  now?: () => number;
}

export interface ForkState {
  comparison: ForkComparison;
  /** Consecutive rounds this verdict has held. */
  streak: number;
  /** True once the verdict has held for confirmRounds. Only then may it act. */
  confirmed: boolean;
  observedAtMs: number;
}

export interface ForkMonitor {
  start: () => void;
  stop: () => void;
  getState: () => ForkState | undefined;
  /** Runs one round immediately. Exposed for the health loop and for tests. */
  check: () => Promise<ForkState>;
}

/** A probe that throws is an observation we do not have, never a verdict. */
async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/**
 * Compares our node's history against reference nodes on a slow, independent
 * timer.
 *
 * Confirmation lives here rather than in the health monitor's hysteresis. The
 * health loop ticks every minute but reads this cached state, so three health
 * ticks can pass on the strength of ONE observation — which would let a single
 * round trip a kill switch that only a human can reset. Requiring the verdict to
 * repeat across `confirmRounds` genuinely independent rounds is what makes the
 * evidence proportionate to the consequence.
 */
export function createForkMonitor(deps: ForkMonitorDeps): ForkMonitor {
  const now = deps.now ?? Date.now;
  let state: ForkState | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  // A round talks to several nodes and can outlast the interval on a slow one.
  // Two rounds in flight would each record an observation and each bump the
  // streak, turning one piece of evidence into two — which is precisely what
  // confirmRounds exists to prevent.
  let inFlight: Promise<ForkState> | undefined;

  async function check(): Promise<ForkState> {
    if (inFlight) return inFlight;
    inFlight = round().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  async function round(): Promise<ForkState> {
    const localHeight = await attempt(() => deps.local.getHeadHeight());
    const referenceHeights = await Promise.all(
      deps.references.map(async (probe) => ({
        probe,
        height: await attempt(() => probe.getHeadHeight()),
      })),
    );

    // A node stuck far behind cannot vote on recent history: including it would
    // drag the comparison back to ancient blocks everyone agrees on, and report
    // "agreed" while a fork at the head goes unseen. `depth` is already our
    // stated tolerance for how far back a meaningful comparison reaches.
    const knownHeights = [localHeight, ...referenceHeights.map((r) => r.height)].filter(
      (h): h is number => h !== undefined,
    );
    const bestHeight = knownHeights.length > 0 ? Math.max(...knownHeights) : undefined;
    const voters = referenceHeights.map((r) => ({
      probe: r.probe,
      height:
        r.height !== undefined && bestHeight !== undefined && r.height >= bestHeight - deps.depth
          ? r.height
          : undefined,
    }));

    const votingHeights = [localHeight, ...voters.map((v) => v.height)].filter(
      (h): h is number => h !== undefined,
    );
    const height = chooseComparisonHeight(votingHeights, deps.depth);

    let local: NodeBlock | undefined;
    let references: ReferenceObservation[];

    if (height === undefined) {
      references = deps.references.map((p) => ({ host: p.host, block: undefined }));
    } else {
      local = await attempt(() => deps.local.getBlockAt(height));
      references = await Promise.all(
        voters.map(async (v) => ({
          host: v.probe.host,
          block: v.height === undefined ? undefined : await attempt(() => v.probe.getBlockAt(height)),
        })),
      );
    }

    const comparison = compareChains(height, local, references);
    const observedAtMs = now();
    const streak = state && state.comparison.verdict === comparison.verdict ? state.streak + 1 : 1;

    state = {
      comparison,
      streak,
      confirmed: streak >= deps.confirmRounds,
      observedAtMs,
    };

    recordForkObservation(deps.db, comparison, Math.floor(observedAtMs / 1000));
    return state;
  }

  return {
    start() {
      // Idempotent: a second start would leave the first interval running with
      // nothing holding a handle to it, and every round it fired would be
      // another duplicate observation nobody could stop.
      if (timer) return;
      void check();
      timer = setInterval(() => void check(), deps.intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    getState: () => state,
    check,
  };
}
