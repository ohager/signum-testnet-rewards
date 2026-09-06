import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { createForkMonitor } from "../../src/health/forkMonitor.ts";
import type { BlockProbe } from "../../src/chain/blockProbe.ts";
import type { NodeBlock } from "../../src/health/forkCheck.ts";

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

const NOW = 1_800_000_000_000;
const OURS: NodeBlock = { blockId: "111", generationSignature: "aaaa" };
const THEIRS: NodeBlock = { blockId: "222", generationSignature: "bbbb" };

/** A node that answers with `block` at every height it is asked about. */
const probe = (host: string, height: number, block: NodeBlock): BlockProbe => ({
  host,
  getHeadHeight: async () => height,
  getBlockAt: async () => block,
});

const deadProbe = (host: string): BlockProbe => ({
  host,
  getHeadHeight: async () => { throw new Error("unreachable"); },
  getBlockAt: async () => { throw new Error("unreachable"); },
});

const monitorWith = (local: BlockProbe, references: BlockProbe[], confirmRounds = 3) =>
  createForkMonitor({
    db, local, references,
    depth: 10, intervalMs: 300_000, confirmRounds,
    now: () => NOW,
  });

describe("fork monitor", () => {
  test("asks every node about the same height, stepped back by the depth", async () => {
    const asked: number[] = [];
    const recording = (host: string, height: number): BlockProbe => ({
      host,
      getHeadHeight: async () => height,
      getBlockAt: async (h) => { asked.push(h); return OURS; },
    });
    await monitorWith(recording("local", 1000), [recording("a", 1002)]).check();
    // Lowest height is 1000, minus depth 10.
    expect(asked).toEqual([990, 990]);
  });

  test("reports agreement when the references match us", async () => {
    const state = await monitorWith(probe("local", 1000, OURS), [
      probe("a", 1000, OURS), probe("b", 1001, OURS),
    ]).check();
    expect(state.comparison.verdict).toBe("agreed");
  });

  test("CONFIRMATION: one round of divergence is not yet actionable", async () => {
    const monitor = monitorWith(probe("local", 1000, OURS), [probe("a", 1000, THEIRS)]);
    const first = await monitor.check();
    expect(first.comparison.verdict).toBe("forked");
    expect(first.confirmed).toBe(false);

    expect((await monitor.check()).confirmed).toBe(false);
    const third = await monitor.check();
    expect(third.streak).toBe(3);
    expect(third.confirmed).toBe(true);
  });

  test("CONFIRMATION: a verdict that changes restarts the streak", async () => {
    let block = THEIRS;
    const flapping: BlockProbe = {
      host: "a",
      getHeadHeight: async () => 1000,
      getBlockAt: async () => block,
    };
    const monitor = monitorWith(probe("local", 1000, OURS), [flapping]);
    await monitor.check();
    await monitor.check();
    block = OURS;
    const third = await monitor.check();
    expect(third.comparison.verdict).toBe("agreed");
    expect(third.streak).toBe(1);
  });

  test("SILENCE IS NOT EVIDENCE: unreachable references are unknown, never a fork", async () => {
    const state = await monitorWith(probe("local", 1000, OURS), [
      deadProbe("a"), deadProbe("b"),
    ]).check();
    expect(state.comparison.verdict).toBe("unknown");
    expect(state.comparison.abstainingHosts).toEqual(["a", "b"]);
  });

  test("our own node being unreachable is unknown, not a fork", async () => {
    const state = await monitorWith(deadProbe("local"), [probe("a", 1000, OURS)]).check();
    expect(state.comparison.verdict).toBe("unknown");
  });

  test("A STUCK REFERENCE MUST NOT BLIND US: it abstains instead of dragging the height back", async () => {
    // The stuck node is 500 blocks behind. Were it allowed to vote, every check
    // would compare ancient history where all nodes agree, hiding a live fork.
    const state = await monitorWith(probe("local", 1000, OURS), [
      probe("stuck", 500, OURS), probe("current", 1000, THEIRS),
    ]).check();
    expect(state.comparison.height).toBe(990);
    expect(state.comparison.abstainingHosts).toEqual(["stuck"]);
    expect(state.comparison.verdict).toBe("forked");
  });

  test("records every round for the post-mortem, agreements included", async () => {
    const monitor = monitorWith(probe("local", 1000, OURS), [probe("a", 1000, OURS)]);
    await monitor.check();
    await monitor.check();
    const rows = db.query("SELECT verdict FROM fork_observations").all() as { verdict: string }[];
    expect(rows.map((r) => r.verdict)).toEqual(["agreed", "agreed"]);
  });

  test("exposes the latest state only after a round has run", async () => {
    const monitor = monitorWith(probe("local", 1000, OURS), [probe("a", 1000, OURS)]);
    expect(monitor.getState()).toBeUndefined();
    await monitor.check();
    expect(monitor.getState()?.comparison.verdict).toBe("agreed");
  });
});
