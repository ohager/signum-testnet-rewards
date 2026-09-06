import { test, expect, describe } from "bun:test";
import { compareChains, chooseComparisonHeight } from "../../src/health/forkCheck.ts";
import type { NodeBlock, ReferenceObservation } from "../../src/health/forkCheck.ts";

const H = 980_000;

const ours: NodeBlock = { blockId: "111", generationSignature: "aaaaaaaaaaaaaaaa" };
const theirs: NodeBlock = { blockId: "222", generationSignature: "bbbbbbbbbbbbbbbb" };

const ref = (host: string, block: NodeBlock | undefined): ReferenceObservation => ({ host, block });

describe("compareChains", () => {
  test("agrees when every reachable reference has our block", () => {
    const result = compareChains(H, ours, [ref("a", ours), ref("b", ours)]);
    expect(result.verdict).toBe("agreed");
    expect(result.agreeingHosts).toEqual(["a", "b"]);
  });

  test("THE KEY CASE: our node against a majority of references is a fork", () => {
    const result = compareChains(H, ours, [ref("a", theirs), ref("b", theirs), ref("c", ours)]);
    expect(result.verdict).toBe("forked");
    expect(result.disagreeingHosts).toEqual(["a", "b"]);
    expect(result.message).toContain("orphaned chain");
  });

  test("a single dissenting reference is the reference's problem, not a fork", () => {
    const result = compareChains(H, ours, [ref("a", ours), ref("b", ours), ref("c", theirs)]);
    expect(result.verdict).toBe("references_disagree");
    expect(result.disagreeingHosts).toEqual(["c"]);
  });

  test("a tie counts in our favour: 2-vs-2 must not trip the kill switch", () => {
    const result = compareChains(H, ours, [
      ref("a", ours), ref("b", ours), ref("c", theirs), ref("d", theirs),
    ]);
    expect(result.verdict).toBe("references_disagree");
  });

  test("with a single reference, disagreement means we are in the minority", () => {
    expect(compareChains(H, ours, [ref("a", theirs)]).verdict).toBe("forked");
  });

  test("a matching block id with a differing generation signature is still a fork", () => {
    const sameIdOtherSig: NodeBlock = { blockId: "111", generationSignature: "cccccccccccccccc" };
    const result = compareChains(H, ours, [ref("a", sameIdOtherSig), ref("b", sameIdOtherSig)]);
    expect(result.verdict).toBe("forked");
  });

  test("SILENCE IS NOT EVIDENCE: no reachable reference is unknown, never a fork", () => {
    const result = compareChains(H, ours, [ref("a", undefined), ref("b", undefined)]);
    expect(result.verdict).toBe("unknown");
    expect(result.abstainingHosts).toEqual(["a", "b"]);
  });

  test("an unreachable reference does not vote, but the reachable ones still decide", () => {
    const result = compareChains(H, ours, [ref("a", theirs), ref("b", undefined)]);
    expect(result.verdict).toBe("forked");
    expect(result.abstainingHosts).toEqual(["b"]);
  });

  test("no configured references is unknown", () => {
    const result = compareChains(H, ours, []);
    expect(result.verdict).toBe("unknown");
    expect(result.message).toContain("No reference nodes configured");
  });

  test("our own node failing to answer is unknown, not a fork", () => {
    expect(compareChains(H, undefined, [ref("a", ours)]).verdict).toBe("unknown");
  });

  test("no comparable height is unknown", () => {
    expect(compareChains(undefined, ours, [ref("a", ours)]).verdict).toBe("unknown");
  });
});

describe("chooseComparisonHeight", () => {
  test("steps back from the lowest height any node reports", () => {
    expect(chooseComparisonHeight([1000, 1002, 1001], 10)).toBe(990);
  });

  test("returns undefined when nothing was reported", () => {
    expect(chooseComparisonHeight([], 10)).toBeUndefined();
  });

  test("returns undefined rather than a negative height on a near-genesis chain", () => {
    expect(chooseComparisonHeight([5], 10)).toBeUndefined();
  });
});