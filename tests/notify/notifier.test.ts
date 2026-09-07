import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import {
  openAlert,
  listUnnotifiedAlerts,
  listOpenAlerts,
  recordNotice,
  claimAlertForNotification,
} from "../../src/ledger/alerts.ts";
import { createNotifier } from "../../src/notify/notifier.ts";
import type { Channel } from "../../src/notify/channel.ts";
import type { Logger } from "../../src/log.ts";
import { setChannelEnabled } from "../../src/ledger/channelState.ts";

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

describe("CONCURRENT DELIVERY: one incident is one notification", () => {
  /** A channel that hangs until released, so two flushes are genuinely in flight at once. */
  const slowChannel = (name: string) => {
    const sent: string[] = [];
    let release: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const channel: Channel = {
      name,
      minSeverity: "warning",
      async send(message) {
        markStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        sent.push(message.title);
      },
    };
    return { sent, started, channel, release: () => release() };
  };

  test("TEN EMAILS FOR ONE FORK: overlapping flushes deliver an alert once", async () => {
    // The bug this fixes, exactly as it happened: `bun --hot` left twelve
    // notifier timers running in one process, they all fired in the same tick,
    // and every one of them read the same undelivered alert before any had
    // marked it sent.
    const slow = slowChannel("email");
    openAlert(db, { kind: "chain_fork", severity: "critical", message: "forked" });

    const notifiers = Array.from({ length: 12 }, () =>
      createNotifier({ db, channels: [slow.channel] }),
    );
    const flushes = notifiers.map((n) => n.flush());
    await slow.started;
    slow.release();
    await Promise.all(flushes);

    expect(slow.sent).toHaveLength(1);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);
  });

  test("a flush that fires while the previous one is still running is skipped", async () => {
    const slow = slowChannel("telegram");
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });

    const notifier = createNotifier({ db, channels: [slow.channel] });
    const first = notifier.flush();
    await slow.started;
    await notifier.flush(); // the timer firing again mid-delivery
    slow.release();
    await first;

    expect(slow.sent).toHaveLength(1);
  });

  test("A CRASHED SENDER MUST NOT BURY THE ALERT: the lease expires and it is retried", async () => {
    // Simulates the process dying between claiming and delivering: the claim is
    // on the row, nothing was sent, and nobody is coming back to finish it.
    openAlert(db, { kind: "testnet_stalled", severity: "critical", message: "stuck" });
    const [alert] = listUnnotifiedAlerts(db);
    expect(claimAlertForNotification(db, alert!.id, { leaseSeconds: 120 })).toBe(true);

    const a = recorder("telegram");
    // A later flush, once the lease has aged out.
    await createNotifier({ db, channels: [a.channel], leaseSeconds: 0 }).flush();
    expect(a.sent).toHaveLength(1);
  });

  test("a failed delivery hands the alert straight back rather than holding the lease", async () => {
    openAlert(db, { kind: "chain_fork", severity: "critical", message: "forked" });
    const broken = recorder("email", { fails: true });
    await createNotifier({ db, channels: [broken.channel] }).flush();

    // No waiting out the lease: the very next flush retries.
    const working = recorder("email");
    await createNotifier({ db, channels: [working.channel] }).flush();
    expect(working.sent).toHaveLength(1);
  });
});

describe("notices", () => {
  test("A NOTICE IS DELIVERED ONCE AND IS NEVER AN OPEN INCIDENT", async () => {
    const a = recorder("telegram");
    recordNotice(db, {
      kind: "fork_halt_released",
      severity: "critical",
      message: "payouts resumed",
    });

    await createNotifier({ db, channels: [a.channel] }).flush();
    expect(a.sent).toEqual(["[CRITICAL] fork_halt_released"]);
    expect(listOpenAlerts(db)).toHaveLength(0);
  });

  test("notices of the same kind can recur, unlike open alerts", async () => {
    recordNotice(db, { kind: "reorg_rolled_back", severity: "warning", message: "first" });
    recordNotice(db, { kind: "reorg_rolled_back", severity: "warning", message: "second" });
    expect(listUnnotifiedAlerts(db)).toHaveLength(2);
  });
});

describe("notifier logging", () => {
  interface Line { level: string; message: string; fields?: Record<string, unknown> }

  const recorder = (): { lines: Line[]; log: Logger } => {
    const lines: Line[] = [];
    const make = (): Logger => ({
      debug: (message, fields) => lines.push({ level: "debug", message, fields }),
      info: (message, fields) => lines.push({ level: "info", message, fields }),
      warn: (message, fields) => lines.push({ level: "warn", message, fields }),
      error: (message, fields) => lines.push({ level: "error", message, fields }),
      child: () => make(),
    });
    return { lines, log: make() };
  };

  const channel = (name: string, minSeverity: "warning" | "critical", send: () => Promise<void>): Channel =>
    ({ name, minSeverity, send });

  test("A SILENTLY BROKEN CHANNEL IS THE WORST FAILURE MODE: rejections are logged", async () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "3 peers" });
    const { lines, log } = recorder();

    await createNotifier({
      db, log,
      channels: [
        channel("discord", "warning", async () => { throw new Error("410 Gone"); }),
        channel("telegram", "warning", async () => {}),
      ],
    }).flush();

    const warn = lines.find((l) => l.level === "warn");
    expect(warn?.fields?.channel).toBe("discord");
    expect(warn?.fields?.error).toBe("410 Gone");
    expect(lines.find((l) => l.level === "info")?.fields?.channels).toBe("telegram");
  });

  test("every channel failing is an error, and the alert stays queued", async () => {
    openAlert(db, { kind: "chain_fork", severity: "critical", message: "forked" });
    const { lines, log } = recorder();

    await createNotifier({
      db, log,
      channels: [channel("email", "critical", async () => { throw new Error("403"); })],
    }).flush();

    expect(lines.some((l) => l.level === "error")).toBe(true);
    expect(listUnnotifiedAlerts(db)).toHaveLength(1);
  });

  test("AN UNROUTABLE SEVERITY IS CONFIG, NOT AN ERROR: no error every flush", async () => {
    // Exactly the shipped setup: email is critical-only and is the only channel,
    // so a warning reaches nobody. Logging that as an error every 30 seconds
    // would train an operator to ignore the line that actually matters.
    openAlert(db, { kind: "low_peers", severity: "warning", message: "3 peers" });
    const { lines, log } = recorder();

    const notifier = createNotifier({
      db, log,
      channels: [channel("email", "critical", async () => {})],
    });
    await notifier.flush();
    await notifier.flush();

    expect(lines.every((l) => l.level === "debug")).toBe(true);
    expect(listUnnotifiedAlerts(db)).toHaveLength(1);
  });
});

describe("muted channels", () => {
  const channel = (name: string, sent: string[]): Channel => ({
    name,
    minSeverity: "warning",
    send: async () => { sent.push(name); },
  });

  test("A MUTED CHANNEL DELIVERS NOTHING, even though it is configured", async () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "3 peers" });
    const sent: string[] = [];
    setChannelEnabled(db, "discord", false);

    await createNotifier({
      db,
      channels: [channel("discord", sent), channel("telegram", sent)],
    }).flush();

    expect(sent).toEqual(["telegram"]);
  });

  test("muting is read per flush, so the panel takes effect without a restart", async () => {
    const sent: string[] = [];
    const notifier = createNotifier({ db, channels: [channel("discord", sent)] });

    openAlert(db, { kind: "low_peers", severity: "warning", message: "first" });
    await notifier.flush();
    expect(sent).toEqual(["discord"]);

    setChannelEnabled(db, "discord", false);
    openAlert(db, { kind: "ws_degraded", severity: "warning", message: "second" });
    await notifier.flush();
    expect(sent).toEqual(["discord"]);
  });

  test("an alert nobody could receive stays queued for when a channel returns", async () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "3 peers" });
    setChannelEnabled(db, "discord", false);

    await createNotifier({ db, channels: [channel("discord", [])] }).flush();

    expect(listUnnotifiedAlerts(db)).toHaveLength(1);
  });
});
