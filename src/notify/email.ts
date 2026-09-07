import type { Channel } from "./channel.ts";
import { CHANNEL_TIMEOUT_MS } from "./channel.ts";
import type { Severity } from "../ledger/alerts.ts";

export interface EmailChannelConfig {
  resendApiKey: string;
  to: string;
  /** Must be a sender on a domain verified in the Resend account. */
  from: string;
  minSeverity: Severity;
}

/**
 * Resend over HTTP rather than SMTP: no long-lived connections to babysit on a
 * Pi, and the same fetch shape as the other channels.
 *
 * `from` is passed in rather than defaulted, because Resend rejects any sender
 * outside a verified domain — a built-in fallback would look configured and
 * silently fail to deliver.
 */
export function createEmailChannel(cfg: EmailChannelConfig): Channel {
  return {
    name: "email",
    minSeverity: cfg.minSeverity,
    async send(message) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.resendApiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
        body: JSON.stringify({
          from: cfg.from,
          to: [cfg.to],
          subject: message.title,
          text: message.body,
        }),
      });
      if (!res.ok) throw new Error(`Resend responded ${res.status}`);
    },
  };
}
