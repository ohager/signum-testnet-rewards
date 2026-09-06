import type { Amount } from "@signumjs/util";
import type { BatchDraft, RecipientAmount } from "../domain/types.ts";
import type { UnpaidAggregate } from "../ledger/batches.ts";
import { sumAmounts } from "../domain/money.ts";

/** signum-node Constants.java: MAX_MULTI_OUT_RECIPIENTS = 64. */
export const MAX_MULTI_OUT_RECIPIENTS = 64;

export interface ComposeOptions {
  minPayout: Amount;
  maxRecipients: number;
}

export interface ComposeResult {
  draft: BatchDraft;
  /** Below the dust threshold; their accruals stay unbatched and roll over. */
  deferredDust: UnpaidAggregate[];
  /** Above the recipient limit; paid in a later batch, oldest first. */
  deferredOverflow: UnpaidAggregate[];
  /**
   * True when exactly one recipient qualifies. signum-node's Attachment.java
   * rejects multi-out with recipients.size() <= 1, so the caller must fall back
   * to an ordinary sendAmount. This is a normal path on quiet days.
   */
  requiresOrdinarySend: boolean;
}

/**
 * Selects who gets paid in the next batch.
 *
 * Ordering is oldest-accrual-first rather than largest-first: with a hard
 * recipient cap, size-ordering would let a steadily-mining large account
 * indefinitely starve smaller ones.
 *
 * Amounts are cloned into the draft so downstream arithmetic cannot mutate the
 * aggregates the caller still holds.
 */
export function composeBatch(aggregates: UnpaidAggregate[], opts: ComposeOptions): ComposeResult {
  const deferredDust: UnpaidAggregate[] = [];
  const eligible: UnpaidAggregate[] = [];

  for (const a of aggregates) {
    if (a.amount.less(opts.minPayout)) deferredDust.push(a);
    else eligible.push(a);
  }

  // Copy before sorting: Array.prototype.sort mutates in place, and the caller's
  // array should not be reordered as a side effect of composing.
  const ordered = [...eligible].sort((x, y) => x.oldestCreatedAt - y.oldestCreatedAt);

  const included = ordered.slice(0, opts.maxRecipients);
  const deferredOverflow = ordered.slice(opts.maxRecipients);

  const recipients: RecipientAmount[] = included.map((a) => ({
    recipientId: a.recipientId,
    amount: a.amount.clone(),
  }));

  return {
    draft: { recipients, total: sumAmounts(recipients.map((r) => r.amount)) },
    deferredDust,
    deferredOverflow,
    requiresOrdinarySend: recipients.length === 1,
  };
}
