import type { ForkObservation } from "./healthState.ts";
import type { ChainHalt } from "../ledger/state.ts";

/**
 * Incidents that stop the money and are not health conditions.
 *
 * Named in one place because three things need the same list: the release rule
 * that must not fire while one is open, the operator action that acknowledges
 * them, and the automatic release that closes the one it just resolved.
 */
export const HALT_INCIDENTS = ["reorg_paid_accrual", "chain_rewound"] as const;

export interface HaltReleaseInputs {
  nowMs: number;
  killSwitchTripped: boolean;
  /** What stopped the money, and where. Undefined when no chain event did. */
  halt: ChainHalt | undefined;
  /** The fork monitor's latest round, or undefined if it has never completed one. */
  fork: ForkObservation | undefined;
  /** Beyond this age a verdict describes the past, not the present. */
  forkStateMaxAgeMs: number;
  /** True while the fork alert is still open, whatever the latest round says. */
  forkAlertOpen: boolean;
  /** Highest height the reorg audit has verified against the node. */
  auditedHeight: number | undefined;
  /** True while a reorg is known to have invalidated an already-paid accrual. */
  paidOrphanOutstanding: boolean;
}

export type HaltReleaseDecision =
  | { kind: "release"; message: string }
  | { kind: "hold"; reason: string };

/**
 * Decides whether a chain halt may lift itself.
 *
 * A chain that reorganises back into agreement does not, on its own, mean the
 * halt was a false alarm — it means the question changed. The question is no
 * longer "are we forked?" but "did anything we accrued turn out to be on the
 * branch that lost?", and only the reorg audit can answer that. So recovery
 * alone releases nothing: the audit must have walked back past the height the
 * trouble was seen at, and it must not have found an accrual that was already
 * paid. Nothing here can put paid SIGNA back.
 *
 * The two causes are judged on the evidence that actually bears on them. A fork
 * is a disagreement with other nodes, so ending it means those nodes agreeing
 * with us again. A rewind is our own node discarding blocks, which no reference
 * node need have an opinion about — requiring one would leave a rewind halt
 * stuck forever wherever fork detection is switched off.
 *
 * Everything the decision rests on is passed in, so the interesting cases —
 * recovered but unaudited, audited but with money already gone — are testable
 * without a chain, a database or a clock.
 *
 * A hold is not a failure. It is the ordinary state on most ticks, which is why
 * it carries a reason rather than a bare false: that reason is what the operator
 * reads when they want to know why payouts are still stopped.
 */
export function decideHaltRelease(inputs: HaltReleaseInputs): HaltReleaseDecision {
  if (!inputs.killSwitchTripped) return { kind: "hold", reason: "payouts are not halted" };
  if (inputs.halt === undefined) {
    // Some other rail stopped the money. Whatever it was, a healthy chain is
    // not evidence about it, and releasing here would be this code silently
    // overruling a halt it knows nothing about.
    return { kind: "hold", reason: "the halt did not come from a chain event" };
  }

  if (inputs.paidOrphanOutstanding) {
    return {
      kind: "hold",
      reason: "a reorg invalidated an accrual that was already paid; a human has to review it",
    };
  }

  if (inputs.halt.cause === "fork") {
    const fork = inputs.fork;
    if (!fork || !fork.confirmed || fork.verdict !== "agreed") {
      return {
        kind: "hold",
        reason: "our chain does not yet confirm agreement with the reference nodes",
      };
    }
    if (inputs.nowMs - fork.observedAtMs > inputs.forkStateMaxAgeMs) {
      // A stale verdict is the fork monitor having stopped, not the chain
      // having healed. Same rule as everywhere else here: silence is not
      // evidence.
      return { kind: "hold", reason: "the last fork check is too old to act on" };
    }
  } else if (inputs.forkAlertOpen) {
    return { kind: "hold", reason: "a chain fork is still open" };
  }

  if (inputs.auditedHeight === undefined || inputs.auditedHeight < inputs.halt.height) {
    return {
      kind: "hold",
      reason:
        `the reorg audit has verified up to ` +
        `${inputs.auditedHeight ?? "no height"} and has not reached ${inputs.halt.height} yet`,
    };
  }

  const cause =
    inputs.halt.cause === "fork"
      ? `The fork at height ${inputs.halt.height} resolved: our node agrees with the reference nodes again`
      : `The chain rewind below height ${inputs.halt.height} has been rebuilt`;

  return {
    kind: "release",
    message:
      `${cause}, and the reorg audit has verified every block up to height ` +
      `${inputs.auditedHeight} without finding a paid accrual on the losing branch. ` +
      `Payouts have resumed automatically.`,
  };
}
