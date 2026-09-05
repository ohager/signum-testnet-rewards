import type { Ledger } from "../ledger/db.ts";
import type { Channel } from "./channel.ts";
import { severityAllows } from "./channel.ts";
import { listUnnotifiedAlerts, markAlertNotified } from "../ledger/alerts.ts";

export interface NotifierDeps {
  db: Ledger;
  channels: Channel[];
}

export interface Notifier {
  /** Delivers every alert not yet notified. Safe to call on a timer. */
  flush: () => Promise<void>;
}

/**
 * Fans alerts out to the configured channels.
 *
 * An alert is marked notified only if at least one channel accepted it, so a
 * total outage (the Pi offline) leaves it queued and it fires on reconnect
 * rather than being silently dropped. A channel throwing never propagates: one
 * broken webhook must not stop the others.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  return {
    async flush() {
      for (const alert of listUnnotifiedAlerts(deps.db)) {
        const message = {
          title: `[${alert.severity.toUpperCase()}] ${alert.kind}`,
          body: alert.message,
          severity: alert.severity,
        };

        const delivered: string[] = [];
        for (const channel of deps.channels) {
          if (!severityAllows(channel.minSeverity, alert.severity)) continue;
          try {
            await channel.send(message);
            delivered.push(channel.name);
          } catch {
            // Deliberately swallowed: try the remaining channels, and leave the
            // alert queued if none succeed.
          }
        }

        if (delivered.length > 0) markAlertNotified(deps.db, alert.id, delivered);
      }
    },
  };
}
