import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { openAlert, listUnnotifiedAlerts } from "../../src/ledger/alerts.ts";
import { createNotifier } from "../../src/notify/notifier.ts";
import type { Channel } from "../../src/notify/channel.ts";

let db: Ledger;
beforeEach(() => { db = openLedger(":memory:"); });

const recorder = (name: string, opts: { fails?: boolean } = {}) => {
  const sent: string[] = [];
  const channel: Channel = {
    name,
    minSeverity: "warning",
    async send(message) {
      if (opts.fails) throw new Error(`${name} unavailable`);
      sent.push(message.title);
    },
  };
  return { channel, sent };
};

describe("notifier", () => {
  test("delivers a pending alert to every channel", async () => {
    const a = recorder("telegram");
    const b = recorder("discord");
    openAlert(db, { kind: "testnet_stalled", severity: "critical", message: "no blocks" });
    await createNotifier({ db, channels: [a.channel, b.channel] }).flush();
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);
  });

  test("marks an alert notified when at least one channel succeeds", async () => {
    const ok = recorder("discord");
    const broken = recorder("telegram", { fails: true });
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });
    await createNotifier({ db, channels: [broken.channel, ok.channel] }).flush();
    expect(ok.sent).toHaveLength(1);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);
  });

  test("OFFLINE RETRY: an alert stays queued when every channel fails", async () => {
    const broken = recorder("telegram", { fails: true });
    openAlert(db, { kind: "wallet_low", severity: "warning", message: "low" });
    await createNotifier({ db, channels: [broken.channel] }).flush();
    expect(listUnnotifiedAlerts(db)).toHaveLength(1);
    // Connectivity returns; a working channel drains the queue.
    const ok = recorder("telegram");
    await createNotifier({ db, channels: [ok.channel] }).flush();
    expect(ok.sent).toHaveLength(1);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);
  });

  test("does not resend an already-notified alert", async () => {
    const a = recorder("telegram");
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });
    const notifier = createNotifier({ db, channels: [a.channel] });
    await notifier.flush();
    await notifier.flush();
    expect(a.sent).toHaveLength(1);
  });

  test("SEVERITY ROUTING: a warning skips a critical-only channel", async () => {
    const criticalOnly = recorder("email");
    criticalOnly.channel.minSeverity = "critical";
    const everything = recorder("telegram");
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });
    await createNotifier({ db, channels: [criticalOnly.channel, everything.channel] }).flush();
    expect(criticalOnly.sent).toHaveLength(0);
    expect(everything.sent).toHaveLength(1);
  });

  test("a critical alert reaches a critical-only channel", async () => {
    const criticalOnly = recorder("email");
    criticalOnly.channel.minSeverity = "critical";
    openAlert(db, { kind: "testnet_stalled", severity: "critical", message: "stuck" });
    await createNotifier({ db, channels: [criticalOnly.channel] }).flush();
    expect(criticalOnly.sent).toHaveLength(1);
  });

  test("flushing with no channels configured leaves alerts queued", async () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });
    await createNotifier({ db, channels: [] }).flush();
    expect(listUnnotifiedAlerts(db)).toHaveLength(1);
  });

  test("flushing an empty queue is harmless", async () => {
    const a = recorder("telegram");
    await createNotifier({ db, channels: [a.channel] }).flush();
    expect(a.sent).toHaveLength(0);
  });
});
