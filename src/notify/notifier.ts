import type { Ledger } from "../ledger/db.ts";
import type { Channel } from "./channel.ts";
import { severityAllows } from "./channel.ts";
import {
  listUnnotifiedAlerts,
  markAlertNotified,
  claimAlertForNotification,
  releaseAlertClaim,
} from "../ledger/alerts.ts";
import { isChannelEnabled } from "../ledger/channelState.ts";
import { silentLogger, describeError } from "../log.ts";
import type { Logger } from "../log.ts";

export interface NotifierDeps {
  db: Ledger;
  channels: Channel[];
  log?: Logger;
  /**
   * How long a delivery attempt owns an alert. Must comfortably exceed the
   * slowest channel's timeout, or a slow send and a retry deliver the same
   * alert twice. Defaults to two minutes against a ten-second channel timeout.
   */
  leaseSeconds?: number;
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
  const leaseSeconds = deps.leaseSeconds ?? 120;
  // Guards the common case cheaply: a flush timer that fires again while the
  // previous flush is still waiting on a slow webhook. The database claim below
  // is what actually makes double delivery impossible, including across
  // processes and across hot reloads, which this flag cannot see.
  let flushing = false;

  return {
    async flush() {
      if (flushing) {
        log.debug("flush already in progress; skipping this tick");
        return;
      }
      flushing = true;
      try {
        await drain();
      } finally {
        flushing = false;
      }
    },
  };

  async function drain(): Promise<void> {
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
        (c) => severityAllows(c.minSeverity, alert.severity) && isChannelEnabled(deps.db, c.name),
      );
      if (eligible.length === 0) {
        log.debug("no enabled channel accepts this severity", {
          kind: alert.kind,
          severity: alert.severity,
        });
        continue;
      }

      // Claimed AFTER the eligibility check, so an alert nobody is configured
      // to receive is not repeatedly leased, and only ever by one sender.
      if (!claimAlertForNotification(deps.db, alert.id, { leaseSeconds })) {
        log.debug("another sender already owns this alert", { kind: alert.kind });
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
        log.info("alert delivered", {
          kind: alert.kind,
          channels: delivered.join(", "),
        });
      } else {
        // Handed back rather than left on the lease: the alert is still
        // undelivered, and the next flush should retry it at once.
        releaseAlertClaim(deps.db, alert.id);
        log.error("every channel rejected the alert; it stays queued", {
          kind: alert.kind,
          severity: alert.severity,
          channels: eligible.map((c) => c.name).join(", "),
        });
      }
    }
  }
}
