import { test, expect, describe } from "bun:test";
import { Amount } from "@signumjs/util";
import type { UnsignedTransaction } from "@signumjs/core";
import { simulatePayout, BroadcastAttemptedError } from "../../src/payout/simulate.ts";
import type { SimulationDeps } from "../../src/payout/simulate.ts";
import type { DryRunReport } from "../../src/payout/dryRun.ts";

const unsigned = (over: Partial<UnsignedTransaction> = {}): UnsignedTransaction => ({
  signatureHash: "hash",
  unsignedTransactionBytes: "deadbeef",
  transactionJSON: { type: 0, subtype: 1, amountNQT: "500000000" },
  broadcasted: false,
  requestProcessingTime: 1,
  ...over,
});

const report = (over: Partial<DryRunReport> = {}): DryRunReport => ({
  draft: {
    recipients: [
      { recipientId: "acct-1", amount: Amount.fromSigna("2.5") },
      { recipientId: "acct-2", amount: Amount.fromSigna("2.5") },
    ],
    total: Amount.fromSigna("5"),
  },
  deferredDust: [],
  deferredOverflow: [],
  requiresOrdinarySend: false,
  railsVerdict: { ok: true },
  wouldSend: true,
  ...over,
});

const deps = (over: Partial<SimulationDeps> = {}): SimulationDeps => ({
  senderPublicKey: "pubkey-hex",
  fee: Amount.fromSigna("0.01"),
  deadlineMinutes: 30,
  sendToMany: async () => unsigned(),
  sendToOne: async () => unsigned(),
  ...over,
});

describe("simulatePayout", () => {
  test("returns the node's unsigned transaction JSON", async () => {
    const result = await simulatePayout(report(), deps());

    expect(result.built).toBe(true);
    expect(result.transaction?.transactionJSON).toEqual({
      type: 0, subtype: 1, amountNQT: "500000000",
    });
    expect(result.transaction?.unsignedTransactionBytes).toBe("deadbeef");
    expect(result.recipientCount).toBe(2);
    expect(result.totalPlanck).toBe("500000000");
  });

  test("NEVER PASSES A PRIVATE KEY: that omission is what makes it a simulation", async () => {
    let seen: Record<string, unknown> = {};
    await simulatePayout(
      report(),
      deps({
        sendToMany: async (args) => {
          seen = args as unknown as Record<string, unknown>;
          return unsigned();
        },
      }),
    );

    expect(seen.senderPublicKey).toBe("pubkey-hex");
    expect(Object.keys(seen)).not.toContain("senderPrivateKey");
    expect(JSON.stringify(seen)).not.toContain("PrivateKey");
  });

  test("A BROADCASTED RESPONSE IS REFUSED, never reported as a simulation", async () => {
    await expect(
      simulatePayout(report(), deps({ sendToMany: async () => unsigned({ broadcasted: true }) })),
    ).rejects.toBeInstanceOf(BroadcastAttemptedError);
  });

  test("a single recipient uses the ordinary send that signum-node requires", async () => {
    let usedMulti = false;
    let usedSingle = false;
    await simulatePayout(
      report({
        requiresOrdinarySend: true,
        draft: {
          recipients: [{ recipientId: "acct-1", amount: Amount.fromSigna("5") }],
          total: Amount.fromSigna("5"),
        },
      }),
      deps({
        sendToMany: async () => { usedMulti = true; return unsigned(); },
        sendToOne: async () => { usedSingle = true; return unsigned(); },
      }),
    );

    expect(usedSingle).toBe(true);
    expect(usedMulti).toBe(false);
  });

  test("passes the recipients and fee the batch would actually use", async () => {
    let args: { recipientAmounts: { recipient: string; amountNQT: string }[]; feePlanck: string } | undefined;
    await simulatePayout(
      report(),
      deps({
        fee: Amount.fromSigna("1"),
        sendToMany: async (a) => { args = a; return unsigned(); },
      }),
    );

    expect(args?.recipientAmounts).toEqual([
      { recipient: "acct-1", amountNQT: "250000000" },
      { recipient: "acct-2", amountNQT: "250000000" },
    ]);
    expect(args?.feePlanck).toBe("100000000");
  });

  test("nothing to pay is reported, not attempted", async () => {
    let called = false;
    const result = await simulatePayout(
      report({ draft: { recipients: [], total: Amount.Zero() }, wouldSend: false }),
      deps({ sendToMany: async () => { called = true; return unsigned(); } }),
    );

    expect(result.built).toBe(false);
    expect(result.reason).toContain("Nothing to pay");
    expect(called).toBe(false);
  });

  test("shadow mode without a seed says so instead of failing", async () => {
    const result = await simulatePayout(report(), deps({ senderPublicKey: undefined }));

    expect(result.built).toBe(false);
    expect(result.reason).toContain("PAYOUT_ACCOUNT_SEED");
  });

  test("A RAIL VIOLATION STILL BUILDS: seeing what would have been sent is the point", async () => {
    const result = await simulatePayout(
      report({ railsVerdict: { ok: false, violation: "per_batch", detail: "batch exceeds MAX_PER_BATCH_SIGNA" }, wouldSend: false }),
      deps(),
    );

    expect(result.built).toBe(true);
    expect(result.railsVerdict.ok).toBe(false);
  });
});
