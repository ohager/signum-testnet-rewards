import { test, expect, describe } from "bun:test";
import { Amount } from "@signumjs/util";
import {
  toPlanckInt,
  fromPlanckInt,
  sumAmounts,
  zero,
  MoneyError,
} from "../../src/domain/money.ts";

describe("planck integer conversion", () => {
  test("round-trips a whole-planck amount", () => {
    const amount = Amount.fromSigna("2.5");
    expect(toPlanckInt(amount)).toBe(250_000_000);
    expect(fromPlanckInt(250_000_000).getSigna()).toBe("2.5");
  });

  test("zero round-trips", () => {
    expect(toPlanckInt(Amount.Zero())).toBe(0);
    expect(fromPlanckInt(0).getPlanck()).toBe("0");
  });

  test("Amount always rounds to whole planck, so sub-planck values cannot occur", () => {
    // Documents library behaviour the rest of the code depends on: Amount is
    // configured with 8 decimals and rounds on every operation, so getPlanck()
    // is always an integer string. toPlanckInt keeps a guard anyway, but this is
    // why it can never fire in practice.
    expect(Amount.fromPlanck("1").divide(3).getPlanck()).toBe("0");
    expect(Amount.fromPlanck("10").divide(3).getPlanck()).toBe("3");
    expect(Amount.fromPlanck("1.5").getPlanck()).toBe("2");
  });

  test("SILENT ROUNDING: fromSigna accepts over-precise input and rounds it", () => {
    // 9 decimals is finer than a planck. The library does NOT complain, which is
    // why config validation must check decimal places on the raw string rather
    // than relying on Amount to reject the value.
    expect(Amount.fromSigna("0.123456789").getPlanck()).toBe("12345679");
  });

  test("rejects a value beyond JS safe-integer range", () => {
    const huge = Amount.fromPlanck("9007199254740993");
    expect(() => toPlanckInt(huge)).toThrow(MoneyError);
  });
});

describe("sumAmounts", () => {
  test("adds a list of amounts", () => {
    const total = sumAmounts([Amount.fromSigna("1"), Amount.fromSigna("2.5")]);
    expect(total.getSigna()).toBe("3.5");
  });

  test("MUTATION SAFETY: does not modify its inputs", () => {
    const a = Amount.fromSigna("1");
    const b = Amount.fromSigna("2");
    sumAmounts([a, b]);
    expect(a.getSigna()).toBe("1");
    expect(b.getSigna()).toBe("2");
  });

  test("summing twice yields the same result", () => {
    const list = [Amount.fromSigna("1"), Amount.fromSigna("2")];
    expect(sumAmounts(list).getSigna()).toBe(sumAmounts(list).getSigna());
  });

  test("an empty list sums to zero", () => {
    expect(sumAmounts([]).getPlanck()).toBe("0");
  });

  test("zero() returns a fresh object each time, never a shared one", () => {
    const a = zero();
    const b = zero();
    a.add(Amount.fromSigna("5"));
    expect(b.getSigna()).toBe("0");
  });
});
