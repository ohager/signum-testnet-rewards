import type { Amount } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { RailsConfig, RailsVerdict } from "../domain/rails.ts";
import { checkRails } from "../domain/rails.ts";
import { aggregateUnpaidByRecipient } from "../ledger/batches.ts";
import { composeBatch, MAX_MULTI_OUT_RECIPIENTS } from "./compose.ts";
import type { ComposeResult } from "./compose.ts";

export interface DryRunOptions {
  minPayout: Amount;
  rails: RailsConfig;
  spentToday: Amount;
}

export interface DryRunReport extends ComposeResult {
  railsVerdict: RailsVerdict;
  wouldSend: boolean;
}

/**
 * Composes a batch and evaluates the rails WITHOUT claiming accruals, creating a
 * batch row, or touching the network.
 *
 * This is the pre-flight check before the first real payout: it shows exactly
 * who would receive what, and is safe to run at any time from the admin UI.
 */
export function dryRunBatch(db: Ledger, opts: DryRunOptions): DryRunReport {
  const composed = composeBatch(aggregateUnpaidByRecipient(db), {
    minPayout: opts.minPayout,
    maxRecipients: MAX_MULTI_OUT_RECIPIENTS,
  });

  if (composed.draft.recipients.length === 0) {
    return { ...composed, railsVerdict: { ok: true }, wouldSend: false };
  }

  const railsVerdict = checkRails(composed.draft, opts.rails, opts.spentToday);
  return { ...composed, railsVerdict, wouldSend: railsVerdict.ok };
}
