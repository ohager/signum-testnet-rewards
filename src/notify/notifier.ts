import type { Ledger } from "../ledger/db.ts";
import type { Channel } from "./channel.ts";
import { severityAllows } from "./channel.ts";
import { listUnnotifiedAlerts, markAlertNotified } from "../ledger/alerts.ts";
import { isChannelEnabled } from "../ledger/channelState.ts";
import { silentLogger, describeError } from "../log.ts";
import type { Logger } from "../log.ts";

export interface NotifierDeps {
  db: Ledger;
  channels: Channel[];
  log?: Logger;
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
 * broken webhook must not stop the others — but it IS logged, because a channel
 * that has been failing for a week is otherwise indistinguishable from a quiet
 * week, which is the worst possible failure mode for an alerting path.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const log = deps.log ?? silentLogger();

  return {
    async flush() {
      for (const alert of listUnnotifiedAlerts(deps.db)) {
        const message = {
          title: `[${alert.severity.toUpperCase()}] ${alert.kind}`,
          body: alert.message,
          severity: alert.severity,
        };

        // Separated from delivery so that "nobody is configured to receive this"
        // and "everyone who should have received it failed" are not the same
        // event. The first is a config choice — email is critical-only by
        // default — and logging it as an error every flush would train an
        // operator to ignore the line that matters.
        // Muting is checked per flush rather than at construction, so toggling a
        // channel in the admin panel takes effect on the next flush instead of
        // on the next restart.
        const eligible = deps.channels.filter(
          (c) =>
            severityAllows(c.minSeverity, alert.severity) && isChannelEnabled(deps.db, c.name),
        );
        if (eligible.length === 0) {
          log.debug("no enabled channel accepts this severity", {
            kind: alert.kind,
            severity: alert.severity,
          });
          continue;
        }

        const delivered: string[] = [];
        for (const channel of eligible) {
          try {
            await channel.send(message);
            delivered.push(channel.name);
          } catch (e) {
            // Never rethrown: the remaining channels still get their chance, and
            // the alert stays queued if none succeed.
            log.warn("channel rejected an alert", {
              channel: channel.name,
              kind: alert.kind,
              error: describeError(e),
            });
          }
        }

        if (delivered.length > 0) {
          markAlertNotified(deps.db, alert.id, delivered);
          log.info("alert delivered", { kind: alert.kind, channels: delivered.join(", ") });
        } else {
          log.error("every channel rejected the alert; it stays queued", {
            kind: alert.kind,
            severity: alert.severity,
            channels: eligible.map((c) => c.name).join(", "),
          });
        }
      }
    },
  };
}
