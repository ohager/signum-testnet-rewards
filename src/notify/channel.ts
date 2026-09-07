import type { Severity } from "../ledger/alerts.ts";

export interface NotificationMessage {
  title: string;
  body: string;
  severity: Severity;
}

export interface Channel {
  name: string;
  /** 'warning' receives everything; 'critical' receives only critical alerts. */
  minSeverity: Severity;
  send: (message: NotificationMessage) => Promise<void>;
}

export function severityAllows(channelMin: Severity, messageSeverity: Severity): boolean {
  if (channelMin === "warning") return true;
  return messageSeverity === "critical";
}

/**
 * How long any one channel may take to accept a message.
 *
 * Bun's fetch has no timeout of its own, so a webhook that accepts the
 * connection and then goes quiet would hold the whole delivery loop — and with
 * it the next flush tick, and the one after that. Ten seconds is far longer
 * than any of these APIs need and far shorter than the delivery lease.
 */
export const CHANNEL_TIMEOUT_MS = 10_000;
