/**
 * Identity of a block as reported by one node.
 *
 * Both fields are compared. The block id is the canonical identity; the
 * generation signature is derived from the parent chain, so a mismatch in
 * either means the two nodes do not share history at that height.
 */
export interface NodeBlock {
  blockId: string;
  generationSignature: string;
}

/**
 * `block` absent means the node abstains from this round: it did not answer, or
 * it is too far behind to have a comparable opinion. Silence is never evidence
 * of a fork.
 */
export interface ReferenceObservation {
  host: string;
  block: NodeBlock | undefined;
}

export type ForkVerdict = "agreed" | "forked" | "references_disagree" | "unknown";

export interface ForkComparison {
  verdict: ForkVerdict;
  /** The height every node was asked about. Undefined only when no height could be chosen. */
  height: number | undefined;
  local: NodeBlock | undefined;
  agreeingHosts: string[];
  disagreeingHosts: string[];
  abstainingHosts: string[];
  message: string;
}

const fingerprint = (b: NodeBlock): string => `${b.blockId}/${b.generationSignature}`;

const shortId = (b: NodeBlock): string =>
  `block ${b.blockId} (gen sig ${b.generationSignature.slice(0, 12)}…)`;

/**
 * Decides whether the local node shares history with its reference nodes.
 *
 * Pure: every observation is passed in, so each verdict is directly testable
 * without a network.
 *
 * The rule is deliberately asymmetric. `forked` — the verdict that halts
 * payouts — requires the local node to disagree with the MAJORITY of reachable
 * references, because that is the only case where our accruals are plausibly on
 * the losing chain. References that disagree with each other while agreeing with
 * us are their problem, not ours, and produce a warning instead: a single broken
 * reference node must never be able to stop the money.
 *
 * A tie counts in the local node's favour. In a 2-vs-2 split we are not in the
 * minority, and tripping a kill switch that only a human can reset needs better
 * evidence than a coin flip.
 */
export function compareChains(
  height: number | undefined,
  local: NodeBlock | undefined,
  references: ReferenceObservation[],
): ForkComparison {
  const abstainingHosts = references.filter((r) => !r.block).map((r) => r.host);
  const reachable = references.filter(
    (r): r is { host: string; block: NodeBlock } => r.block !== undefined,
  );

  const unknown = (message: string): ForkComparison => ({
    verdict: "unknown",
    height,
    local,
    agreeingHosts: [],
    disagreeingHosts: [],
    abstainingHosts,
    message,
  });

  if (height === undefined) return unknown("No comparable height across the configured nodes");
  if (!local) return unknown(`Local node did not return block ${height}`);
  if (reachable.length === 0) {
    return unknown(
      references.length === 0
        ? "No reference nodes configured"
        : `No reference node answered for block ${height}`,
    );
  }

  const localFp = fingerprint(local);
  const agreeing = reachable.filter((r) => fingerprint(r.block) === localFp);
  const disagreeing = reachable.filter((r) => fingerprint(r.block) !== localFp);
  const agreeingHosts = agreeing.map((r) => r.host);
  const disagreeingHosts = disagreeing.map((r) => r.host);

  if (disagreeing.length === 0) {
    return {
      verdict: "agreed",
      height,
      local,
      agreeingHosts,
      disagreeingHosts,
      abstainingHosts,
      message: `All ${reachable.length} reference node(s) agree on block ${height}`,
    };
  }

  // Largest group among the references alone; the local node is not a voter in
  // its own trial.
  const counts = new Map<string, number>();
  for (const r of reachable) {
    const fp = fingerprint(r.block);
    counts.set(fp, (counts.get(fp) ?? 0) + 1);
  }
  const largestGroup = Math.max(...counts.values());

  if (agreeing.length >= largestGroup) {
    return {
      verdict: "references_disagree",
      height,
      local,
      agreeingHosts,
      disagreeingHosts,
      abstainingHosts,
      message:
        `Reference nodes disagree at height ${height}: ` +
        `${disagreeingHosts.join(", ")} differ from our node and from ` +
        `${agreeingHosts.join(", ") || "the rest"}. Our chain matches the majority.`,
    };
  }

  const majority = disagreeing.find((r) => (counts.get(fingerprint(r.block)) ?? 0) === largestGroup);

  return {
    verdict: "forked",
    height,
    local,
    agreeingHosts,
    disagreeingHosts,
    abstainingHosts,
    message:
      `Chain fork at height ${height}: our node has ${shortId(local)}, ` +
      `while ${largestGroup} of ${reachable.length} reference node(s) ` +
      `(${disagreeingHosts.join(", ")}) have ${majority ? shortId(majority.block) : "another block"}. ` +
      `Rewards accrued above this height may be on an orphaned chain.`,
  };
}

/**
 * The height to ask every node about.
 *
 * Stepping back from the LOWEST height any node reports serves two purposes:
 * every node certainly has the block, and ordinary propagation skew — nodes are
 * always a few seconds and a block or two apart — cannot masquerade as a fork.
 * Short reorgs are normal on any chain; only a divergence that survives `depth`
 * blocks is worth waking someone for.
 */
export function chooseComparisonHeight(heights: number[], depth: number): number | undefined {
  if (heights.length === 0) return undefined;
  const height = Math.min(...heights) - depth;
  return height >= 0 ? height : undefined;
}