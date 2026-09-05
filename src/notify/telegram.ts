import type { Channel } from "./channel.ts";
import type { Severity } from "../ledger/alerts.ts";

export function createTelegramChannel(
  cfg: { botToken: string; chatId: string },
  minSeverity: Severity = "warning",
): Channel {
  return {
    name: "telegram",
    minSeverity,
    async send(message) {
      const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text: `*${message.title}*\n${message.body}`,
          parse_mode: "Markdown",
        }),
      });
      if (!res.ok) throw new Error(`Telegram responded ${res.status}`);
    },
  };
}
