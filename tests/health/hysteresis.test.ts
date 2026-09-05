import { test, expect, describe } from "bun:test";
import { emptyCounters, applyHysteresis } from "../../src/health/hysteresis.ts";
import type { HealthCondition } from "../../src/health/healthState.ts";

const opts = { openAfterChecks: 3, closeAfterChecks: 3 };
const lowPeers: HealthCondition = { kind: "low_peers", severity: "warning", message: "1 peer" };

describe("applyHysteresis", () => {
  test("does not open an alert on the first sighting", () => {
    expect(applyHysteresis(emptyCounters(), [lowPeers], new Set(), opts).toOpen).toHaveLength(0);
  });
  test("opens only after the condition holds for the required number of checks", () => {
    let counters = emptyCounters();
    let opened: HealthCondition[] = [];
    for (let i = 0; i < 3; i++) {
      const result = applyHysteresis(counters, [lowPeers], new Set(), opts);
      counters = result.counters;
      opened = result.toOpen;
    }
    expect(opened.map((c) => c.kind)).toEqual(["low_peers"]);
  });
  test("FLAPPING: an intermittent condition never opens", () => {
    let counters = emptyCounters();
    for (let i = 0; i < 20; i++) {
      const result = applyHysteresis(counters, i % 2 === 0 ? [lowPeers] : [], new Set(), opts);
      counters = result.counters;
      expect(result.toOpen).toHaveLength(0);
    }
  });
  test("does not re-open an alert that is already open", () => {
    let counters = emptyCounters();
    for (let i = 0; i < 5; i++) {
      counters = applyHysteresis(counters, [lowPeers], new Set(["low_peers"]), opts).counters;
    }
    expect(applyHysteresis(counters, [lowPeers], new Set(["low_peers"]), opts).toOpen).toHaveLength(0);
  });
  test("resolves only after the condition has cleared for the required checks", () => {
    let counters = emptyCounters();
    const open = new Set(["low_peers"]);
    for (let i = 0; i < 2; i++) {
      const result = applyHysteresis(counters, [], open, opts);
      counters = result.counters;
      expect(result.toResolve).toHaveLength(0);
    }
    expect(applyHysteresis(counters, [], open, opts).toResolve).toEqual(["low_peers"]);
  });
  test("does not resolve an alert that is not open", () => {
    let counters = emptyCounters();
    for (let i = 0; i < 5; i++) {
      const result = applyHysteresis(counters, [], new Set(), opts);
      counters = result.counters;
      expect(result.toResolve).toHaveLength(0);
    }
  });
  test("a reappearing condition resets the clear streak", () => {
    let counters = emptyCounters();
    const open = new Set(["low_peers"]);
    counters = applyHysteresis(counters, [], open, opts).counters;
    counters = applyHysteresis(counters, [], open, opts).counters;
    counters = applyHysteresis(counters, [lowPeers], open, opts).counters;
    expect(applyHysteresis(counters, [], open, opts).toResolve).toHaveLength(0);
  });
  test("PURITY: the input counters are not mutated", () => {
    const before = emptyCounters();
    applyHysteresis(before, [lowPeers], new Set(), opts);
    expect(before.size).toBe(0);
  });
});
