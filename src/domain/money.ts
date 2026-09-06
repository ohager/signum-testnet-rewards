import { Amount, AmountFormats } from "@signumjs/util";
import type { PlanckInt } from "./types.ts";

export { Amount };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Converts an Amount to the whole-planck integer stored in SQLite.
 *
 * Amount is BigNumber-backed and can represent sub-planck precision that the
 * database cannot. Rather than rounding silently — which would leak or invent
 * fractions of a planck on the money path — anything that is not a whole,
 * safely-representable integer is rejected.
 */
export function toPlanckInt(amount: Amount): PlanckInt {
  const raw = amount.getPlanck();
  if (!/^-?\d+$/.test(raw)) {
    throw new MoneyError(`Amount is not a whole number of planck: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new MoneyError(`Planck value ${raw} is outside the JS safe-integer range`);
  }
  return n;
}

export function fromPlanckInt(planck: PlanckInt): Amount {
  return Amount.fromPlanck(planck);
}

/** A fresh zero. Never share one: Amount arithmetic mutates in place. */
export function zero(): Amount {
  return Amount.Zero();
}

/**
 * Sums amounts without mutating any input.
 *
 * IMPORTANT: Amount.add() mutates the receiver and returns `this`, so
 * `list.reduce((a, b) => a.add(b))` silently corrupts `list[0]`. Always sum
 * through this helper.
 */
export function sumAmounts(amounts: Amount[]): Amount {
  const total = Amount.Zero();
  for (const a of amounts) total.add(a);
  return total;
}

/** Human-readable, for logs, the admin UI and the status page. */
export function formatSigna(amount: Amount): string {
  return amount.toString(AmountFormats.DotDecimal);
}
