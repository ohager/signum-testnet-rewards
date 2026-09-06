import { test, expect, describe } from "bun:test";
import { Amount } from "@signumjs/util";
import { composeBatch, MAX_MULTI_OUT_RECIPIENTS } from "../../src/payout/compose.ts";
import type { UnpaidAggregate } from "../../src/ledger/batches.ts";

const agg = (recipientId: string, signa: string, oldestCreatedAt = 0): UnpaidAggregate => ({
  recipientId, amount: Amount.fromSigna(signa), accrualCount: 1, oldestCreatedAt,
});

const opts = { minPayout: Amount.fromSigna("5"), maxRecipients: MAX_MULTI_OUT_RECIPIENTS };

describe("composeBatch", () => {
  test("includes recipients at or above the dust threshold", () => {
    const result = composeBatch([agg("a", "5"), agg("b", "9")], opts);
    expect(result.draft.recipients).toHaveLength(2);
    expect(result.draft.total.getSigna()).toBe("14");
  });
  test("DUST ROLLS OVER: below-threshold recipients are deferred, not dropped", () => {
    const result = composeBatch([agg("a", "9"), agg("dusty", "0.1")], opts);
    expect(result.draft.recipients.map((r) => r.recipientId)).toEqual(["a"]);
    expect(result.deferredDust.map((r) => r.recipientId)).toEqual(["dusty"]);
  });
  test("FAIRNESS: orders by oldest accrual first, not by size", () => {
    const result = composeBatch([agg("newer-big", "90", 200), agg("older-small", "6", 100)], opts);
    expect(result.draft.recipients[0]?.recipientId).toBe("older-small");
  });
  test("caps at the node's multi-out limit and defers the remainder", () => {
    const many = Array.from({ length: 70 }, (_, i) => agg(`a${i}`, "6", i));
    const result = composeBatch(many, opts);
    expect(result.draft.recipients).toHaveLength(64);
    expect(result.deferredOverflow).toHaveLength(6);
  });
  test("the deferred overflow is the newest accruals, so the oldest are paid first", () => {
    const many = Array.from({ length: 66 }, (_, i) => agg(`a${i}`, "6", i));
    expect(composeBatch(many, opts).deferredOverflow.map((r) => r.recipientId)).toEqual(["a64", "a65"]);
  });
  test("the total always equals the sum of included recipients", () => {
    expect(composeBatch([agg("a", "6"), agg("b", "7.5")], opts).draft.total.getSigna()).toBe("13.5");
  });
  test("produces an empty draft when everything is dust", () => {
    const result = composeBatch([agg("a", "0.0001")], opts);
    expect(result.draft.recipients).toHaveLength(0);
    expect(result.draft.total.getPlanck()).toBe("0");
  });
  test("flags a single-recipient batch, which cannot use multi-out", () => {
    expect(composeBatch([agg("a", "6")], opts).requiresOrdinarySend).toBe(true);
  });
  test("does not flag ordinary-send for two or more recipients", () => {
    expect(composeBatch([agg("a", "6"), agg("b", "6")], opts).requiresOrdinarySend).toBe(false);
  });
  test("MUTATION SAFETY: composing does not modify the input aggregates", () => {
    const input = [agg("a", "6"), agg("b", "7")];
    composeBatch(input, opts);
    composeBatch(input, opts);
    expect(input[0]?.amount.getSigna()).toBe("6");
    expect(input[1]?.amount.getSigna()).toBe("7");
    expect(opts.minPayout.getSigna()).toBe("5");
  });
  test("MUTATION SAFETY: composing does not reorder the caller's array", () => {
    const input = [agg("late", "6", 500), agg("early", "6", 100)];
    composeBatch(input, opts);
    expect(input.map((a) => a.recipientId)).toEqual(["late", "early"]);
  });
});
