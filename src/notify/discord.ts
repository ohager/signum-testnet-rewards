import type { Channel } from "./channel.ts";
import type { Severity } from "../ledger/alerts.ts";

export function createDiscordChannel(
  cfg: { webhookUrl: string },
  minSeverity: Severity = "warning",
): Channel {
  return {
    name: "discord",
    minSeverity,
    async send(message) {
      const res = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `**${message.title}**\n${message.body}` }),
      });
      if (!res.ok) throw new Error(`Discord responded ${res.status}`);
    },
  };
}
