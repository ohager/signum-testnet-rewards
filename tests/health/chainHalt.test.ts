import { test, expect, describe } from "bun:test";
import { decideHaltRelease } from "../../src/health/chainHalt.ts";
import type { HaltReleaseInputs } from "../../src/health/chainHalt.ts";

const NOW = 1_700_000_000_000;

const inputs = (over: Partial<HaltReleaseInputs> = {}): HaltReleaseInputs => ({
  nowMs: NOW,
  killSwitchTripped: true,
  halt: { height: 1000, cause: "fork" },
  fork: { verdict: "agreed", confirmed: true, message: "all agree", observedAtMs: NOW - 1_000 },
  forkStateMaxAgeMs: 900_000,
  forkAlertOpen: false,
  auditedHeight: 1000,
  paidOrphanOutstanding: false,
  ...over,
});

describe("releasing a chain halt", () => {
  test("a healed fork with a clean audit releases itself", () => {
    const decision = decideHaltRelease(inputs());
    expect(decision.kind).toBe("release");
    expect(decision.kind === "release" && decision.message).toContain("resumed automatically");
  });

  test("AGREEMENT IS NOT ENOUGH: an audit that has not reached the fork holds", () => {
    // The fork is gone, but nothing has yet re-checked whether the blocks we
    // accrued at that height are the ones that survived.
    const decision = decideHaltRelease(inputs({ auditedHeight: 999 }));
    expect(decision.kind).toBe("hold");
    expect(decision.kind === "hold" && decision.reason).toContain("has not reached 1000");
  });

  test("an audit that has never run holds", () => {
    expect(decideHaltRelease(inputs({ auditedHeight: undefined })).kind).toBe("hold");
  });

  test("MONEY ALREADY GONE: a paid orphan is never released automatically", () => {
    // Nothing here can put paid SIGNA back, so nothing here may decide it is fine.
    const decision = decideHaltRelease(inputs({ paidOrphanOutstanding: true }));
    expect(decision.kind).toBe("hold");
    expect(decision.kind === "hold" && decision.reason).toContain("already paid");
  });

  test("a fork verdict that is not yet confirmed holds", () => {
    const fork = { ...inputs().fork!, confirmed: false };
    expect(decideHaltRelease(inputs({ fork })).kind).toBe("hold");
  });

  test("still forked holds, however clean the audit is", () => {
    const fork = { ...inputs().fork!, verdict: "forked" as const };
    expect(decideHaltRelease(inputs({ fork })).kind).toBe("hold");
  });

  test("A STALE VERDICT IS THE MONITOR STOPPING, NOT THE CHAIN HEALING", () => {
    const fork = { ...inputs().fork!, observedAtMs: NOW - 900_001 };
    const decision = decideHaltRelease(inputs({ fork }));
    expect(decision.kind).toBe("hold");
    expect(decision.kind === "hold" && decision.reason).toContain("too old");
  });

  test("a fork check that has never completed a round holds", () => {
    expect(decideHaltRelease(inputs({ fork: undefined })).kind).toBe("hold");
  });

  test("A HALT THIS CODE DID NOT CAUSE IS NOT THIS CODE'S TO LIFT", () => {
    // A rail violation, a failed payout: whatever it was, a healthy chain says
    // nothing about it.
    const decision = decideHaltRelease(inputs({ halt: undefined }));
    expect(decision.kind).toBe("hold");
    expect(decision.kind === "hold" && decision.reason).toContain("did not come from a chain event");
  });

  test("nothing to release when payouts are not halted", () => {
    expect(decideHaltRelease(inputs({ killSwitchTripped: false })).kind).toBe("hold");
  });
});

describe("releasing a rewind halt", () => {
  const rewind = (over: Partial<HaltReleaseInputs> = {}) =>
    decideHaltRelease(inputs({ halt: { height: 1099, cause: "rewind" }, auditedHeight: 1099, ...over }));

  test("a rebuilt chain with a clean audit releases itself", () => {
    const decision = rewind();
    expect(decision.kind).toBe("release");
    expect(decision.kind === "release" && decision.message).toContain("rewind below height 1099");
  });

  test("REFERENCE NODES ARE NOT THE EVIDENCE HERE: no fork check still releases", () => {
    // A rewind is our own node discarding blocks. Requiring reference nodes to
    // vote on it would strand every deployment that runs without them.
    expect(rewind({ fork: undefined }).kind).toBe("release");
  });

  test("an open fork alert holds, because two things are wrong at once", () => {
    expect(rewind({ forkAlertOpen: true }).kind).toBe("hold");
  });

  test("a chain that has not rebuilt past the halt height holds", () => {
    const decision = rewind({ auditedHeight: 1098 });
    expect(decision.kind).toBe("hold");
    expect(decision.kind === "hold" && decision.reason).toContain("has not reached 1099");
  });
});
