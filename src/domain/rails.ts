import { Amount } from "@signumjs/util";
import type { BatchDraft } from "./types.ts";

export interface RailsConfig {
  maxPerRecipientPerBatch: Amount;
  maxPerBatch: Amount;
  /** Wall-clock, deliberately: this bounds how fast the wallet can drain. */
  maxPerWallClockDay: Amount;
}

export type RailViolation =
  | "non_positive_amount"
  | "total_mismatch"
  | "per_recipient"
  | "per_batch"
  | "per_wallclock_day";

export type RailsVerdict =
  | { ok: true }
  | { ok: false; violation: RailViolation; detail: string };

/**
 * Hard ceilings evaluated before a batch is persisted or sent.
 *
 * These guard against bugs rather than attackers: a runaway loop, a bad
 * aggregation, or a policy misconfiguration. Any violation must trip the
 * kill-switch rather than silently shrink the batch.
 */
export function checkRails(
  draft: BatchDraft,
  cfg: RailsConfig,
  spentWallClockToday: Amount,
): RailsVerdict {
  const runningTotal = Amount.Zero();

  for (const r of draft.recipients) {
    if (!r.amount.greater(Amount.Zero())) {
      return {
        ok: false,
        violation: "non_positive_amount",
        detail: `${r.recipientId} has amount ${r.amount.getSigna()}`,
      };
    }
    if (r.amount.greater(cfg.maxPerRecipientPerBatch)) {
      return {
        ok: false,
        violation: "per_recipient",
        detail: `${r.recipientId}: ${r.amount.getSigna()} > ${cfg.maxPerRecipientPerBatch.getSigna()}`,
      };
    }
    runningTotal.add(r.amount);
  }

  if (!runningTotal.equals(draft.total)) {
    return {
      ok: false,
      violation: "total_mismatch",
      detail: `recipients sum to ${runningTotal.getSigna()} but total says ${draft.total.getSigna()}`,
    };
  }
  if (draft.total.greater(cfg.maxPerBatch)) {
    return {
      ok: false,
      violation: "per_batch",
      detail: `${draft.total.getSigna()} > ${cfg.maxPerBatch.getSigna()}`,
    };
  }

  const projectedDay = spentWallClockToday.clone().add(draft.total);
  if (projectedDay.greater(cfg.maxPerWallClockDay)) {
    return {
      ok: false,
      violation: "per_wallclock_day",
      detail: `${spentWallClockToday.getSigna()} + ${draft.total.getSigna()} > ${cfg.maxPerWallClockDay.getSigna()}`,
    };
  }

  return { ok: true };
}
