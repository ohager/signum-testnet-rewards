import type { Channel } from "./channel.ts";
import type { Severity } from "../ledger/alerts.ts";

/**
 * Resend over HTTP rather than SMTP: no long-lived connections to babysit on a
 * Pi, and the same fetch shape as the other channels.
 *
 * The `from` address must be a domain verified in the Resend account;
 * onboarding@resend.dev works for testing on the free tier.
 */
export function createEmailChannel(
  cfg: { resendApiKey: string; to: string; from?: string },
  minSeverity: Severity = "critical",
): Channel {
  const from = cfg.from ?? "Signum Testnet Rewards <onboarding@resend.dev>";
  return {
    name: "email",
    minSeverity,
    async send(message) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [cfg.to],
          subject: message.title,
          text: message.body,
        }),
      });
      if (!res.ok) throw new Error(`Resend responded ${res.status}`);
    },
  };
}
