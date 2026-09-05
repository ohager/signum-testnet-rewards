import { test, expect, describe } from "bun:test";
import { Amount } from "@signumjs/util";
import { checkRails } from "../../src/domain/rails.ts";
import type { RailsConfig } from "../../src/domain/rails.ts";
import type { BatchDraft } from "../../src/domain/types.ts";
import { sumAmounts } from "../../src/domain/money.ts";

const rails: RailsConfig = {
  maxPerRecipientPerBatch: Amount.fromSigna("200"),
  maxPerBatch: Amount.fromSigna("2000"),
  maxPerWallClockDay: Amount.fromSigna("3000"),
};

const draft = (signaAmounts: string[]): BatchDraft => {
  const recipients = signaAmounts.map((s, i) => ({
    recipientId: `acct-${i}`,
    amount: Amount.fromSigna(s),
  }));
  return { recipients, total: sumAmounts(recipients.map((r) => r.amount)) };
};

const noSpendYet = Amount.Zero();

describe("checkRails", () => {
  test("passes a normal batch", () => {
    expect(checkRails(draft(["10", "20"]), rails, noSpendYet)).toEqual({ ok: true });
  });

  test("passes a batch sitting exactly on every limit", () => {
    expect(checkRails(draft(["200"]), rails, Amount.fromSigna("2800"))).toEqual({ ok: true });
  });

  test("rejects when one recipient exceeds the per-recipient rail", () => {
    const result = checkRails(draft(["200.00000001"]), rails, noSpendYet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("per_recipient");
  });

  test("rejects when the batch total exceeds the per-batch rail", () => {
    const result = checkRails(draft(Array(11).fill("200")), rails, noSpendYet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("per_batch");
  });

  test("rejects when today's wall-clock spend would be exceeded", () => {
    const result = checkRails(draft(["200"]), rails, Amount.fromSigna("2900"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("per_wallclock_day");
  });

  test("rejects a zero amount, which can only come from a bug", () => {
    const result = checkRails(draft(["0"]), rails, noSpendYet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("non_positive_amount");
  });

  test("rejects a draft whose total disagrees with its recipients", () => {
    const bad: BatchDraft = {
      recipients: [{ recipientId: "a", amount: Amount.fromSigna("1") }],
      total: Amount.fromSigna("999"),
    };
    const result = checkRails(bad, rails, noSpendYet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("total_mismatch");
  });

  test("an empty draft is consistent and passes", () => {
    expect(checkRails({ recipients: [], total: Amount.Zero() }, rails, noSpendYet)).toEqual({
      ok: true,
    });
  });

  test("MUTATION SAFETY: checking does not modify the draft or the rails", () => {
    const d = draft(["10", "20"]);
    checkRails(d, rails, noSpendYet);
    checkRails(d, rails, noSpendYet);
    expect(d.total.getSigna()).toBe("30");
    expect(rails.maxPerBatch.getSigna()).toBe("2000");
    expect(noSpendYet.getSigna()).toBe("0");
  });
});
