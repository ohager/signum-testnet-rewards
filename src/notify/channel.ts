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
