import { loadConfig, resolvePaths } from "./config/load.ts";
import { createLogger, describeError } from "./log.ts";
import { openLedger } from "./ledger/db.ts";
import { createMainnetPool } from "./chain/mainnetPool.ts";
import { createTestnetClient } from "./chain/testnetClient.ts";
import { getFreshAccount, upsertAccount } from "./ledger/mainnetAccounts.ts";
import type { MainnetAccountFacts } from "./eligibility/eligibility.ts";
import { createIndexer } from "./indexer/indexer.ts";
import { createWsMonitor } from "./health/wsMonitor.ts";
import { createHttpProbe } from "./health/httpProbe.ts";
import { createHealthMonitor } from "./health/monitor.ts";
import { createForkMonitor } from "./health/forkMonitor.ts";
import { createBlockProbe, createBlockProbes } from "./chain/blockProbe.ts";
import { createNotifier } from "./notify/notifier.ts";
import { createTelegramChannel } from "./notify/telegram.ts";
import { createDiscordChannel } from "./notify/discord.ts";
import { createEmailChannel } from "./notify/email.ts";
import type { Channel } from "./notify/channel.ts";
import { buildProjection } from "./publish/projection.ts";
import { createTursoPublisher } from "./publish/tursoPublisher.ts";
import { createAdminServer } from "./admin/server.ts";
import { simulatePayout } from "./payout/simulate.ts";
import { createPayoutAccountWatcher } from "./payout/payoutAccount.ts";
import { createPayoutRunner } from "./payout/runner.ts";
import { openAlert } from "./ledger/alerts.ts";
import { computePayoutSchedule } from "./payout/schedule.ts";
import { isPayoutsPaused, isKillSwitchTripped } from "./ledger/state.ts";
import { lastBatchCreatedAt } from "./ledger/batches.ts";
import { generateSignKeys } from "@signumjs/crypto";
import { toChainDay } from "./domain/chainDay.ts";
import { ChainTime } from "@signumjs/util";
import { pruneLedger } from "./ledger/retention.ts";
import {Crypto} from "@signumjs/crypto"
import {NodeJSCryptoAdapter} from "@signumjs/crypto/adapters";

Crypto.init(new NodeJSCryptoAdapter())

/**
 * Tears down whatever a previous evaluation of this module left running.
 *
 * `bun --hot` re-runs this file in the SAME process without unwinding its side
 * effects, so every reload used to stack another set of timers and monitors on
 * top of the last. That is not a cosmetic dev annoyance: twelve accumulated
 * notifier timers all fire in the same tick, all read the same undelivered
 * alert, and one chain fork arrives as ten emails. globalThis survives the
 * reload, so the previous run parks its teardown there for this one to call.
 *
 * The ledger handle is deliberately NOT closed here. Work started by the old
 * evaluation may still be in flight, and a closed database turns that into a
 * crash; the connection is released when the old closure is collected.
 */
declare global {
  // eslint-disable-next-line no-var
  var __rewardsTeardown: (() => void) | undefined;
}
globalThis.__rewardsTeardown?.();
globalThis.__rewardsTeardown = undefined;

// Config validation runs FIRST and throws before anything opens a database.
// The volume sentinel check lives inside loadConfig for exactly this reason.
const config = loadConfig();
const serviceStartedAt = Math.floor(Date.now() / 1000);
const paths = resolvePaths(config);
const db = openLedger(paths.databasePath);

const log = createLogger(config.verboseLogging);
const boot = log.child("boot");

boot.info("data dir", { path: config.dataDir });
boot.info(config.payouts.enabled ? "payouts ENABLED" : "payouts disabled (shadow mode)");
boot.info("reward policy", {
  perBlockSigna: config.policy.rewardPerBlock.getSigna(),
  accountDailyCapSigna: config.policy.accountDailyCap.getSigna(),
  globalDailyBudgetSigna: config.policy.globalDailyBudget.getSigna(),
});

const mainnet = createMainnetPool(config.chain.mainnetNodeHosts);
const testnet = createTestnetClient(config.chain.testnetNodeHost);

/** Cached mainnet lookup. Negative results expire sooner so activation takes effect quickly. */
async function lookupMainnetAccount(accountId: string): Promise<MainnetAccountFacts | undefined> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cached = getFreshAccount(
    db,
    accountId,
    {
      positiveSeconds: config.publish.accountTtlPositiveSeconds,
      negativeSeconds: config.publish.accountTtlNegativeSeconds,
    },
    nowSeconds,
  );
  if (cached) return { isActive: cached.isActive, publicKey: cached.publicKey };

  const account = await mainnet.getAccount(accountId);
  const facts = {
    accountId,
    publicKey: account?.publicKey ?? null,
    isActive: Boolean(account?.publicKey),
  };
  upsertAccount(db, facts, nowSeconds);
  return { isActive: facts.isActive, publicKey: facts.publicKey };
}

const channels: Channel[] = [];
if (config.notify.telegram) channels.push(createTelegramChannel(config.notify.telegram));
if (config.notify.discord) channels.push(createDiscordChannel(config.notify.discord));
if (config.notify.email) channels.push(createEmailChannel(config.notify.email));
boot.info("notification channels", { channels: channels.map((c) => c.name).join(", ") || "none" });

const notifier = createNotifier({ db, channels, log: log.child("notify") });

/**
 * The payout keypair, derived once from the seed.
 *
 * The signing key IS derived now that the runner broadcasts real payouts -- it
 * previously was not, when the service could only simulate. The seed itself
 * still never leaves this scope, and neither key is logged, published or
 * exposed by the admin API: the panel only ever sees the derived address.
 */
const payoutKeys = config.payouts.accountSeed
  ? (() => {
      const k = generateSignKeys(config.payouts.accountSeed);
      return { publicKey: k.publicKey, signPrivateKey: k.signPrivateKey };
    })()
  : undefined;
const payoutPublicKey = payoutKeys?.publicKey;
boot.info(
  payoutPublicKey
    ? "payout account configured"
    : "no payout account seed; payouts and simulation will report it as unconfigured",
);

// The balance is refreshed a good deal more slowly than the admin panel polls.
// It changes only when a payout runs or someone tops the account up, so a
// minute of lag costs nothing, while a lookup per poll would put this service
// on public mainnet nodes several times a second.
const payoutAccount = payoutPublicKey
  ? createPayoutAccountWatcher({
      publicKey: payoutPublicKey,
      getAccount: (accountId) => mainnet.getAccount(accountId),
      ttlSeconds: 60,
    })
  : undefined;
if (payoutAccount) {
  boot.info("payout account", { account: payoutAccount.get().accountRS });
}
const wsMonitor = createWsMonitor(config.chain.testnetWsUrl);

// Fork detection is optional, like publishing: without reference nodes there is
// nothing to compare our history against, and the service still indexes,
// accrues and alerts on everything else.
const referenceProbes = createBlockProbes(config.chain.referenceNodeHosts);
const forkMonitor =
  referenceProbes.length > 0
    ? createForkMonitor({
        db,
        local: createBlockProbe(config.chain.testnetNodeHost),
        references: referenceProbes,
        depth: config.health.forkCheckDepth,
        intervalMs: config.health.forkCheckIntervalSeconds * 1000,
        confirmRounds: config.health.alertOpenAfterChecks,
      })
    : undefined;
if (forkMonitor) {
  boot.info("fork detection enabled", {
    referenceNodes: referenceProbes.length,
    depth: config.health.forkCheckDepth,
  });
} else {
  boot.warn("fork detection disabled: no reference nodes configured");
}

const healthMonitor = createHealthMonitor({
  db,
  config,
  wsMonitor,
  probe: createHttpProbe(testnet),
  intervalMs: 60_000,
  forkMonitor,
  log: log.child("health"),
});

// Publishing is optional: without Turso configured the service still indexes,
// accrues and alerts, so the indexer can be run and verified on its own.
const publisher = config.publish.turso
  ? createTursoPublisher({
      url: config.publish.turso.databaseUrl,
      authToken: config.publish.turso.authToken,
      // A third of the staleness window: often enough that a consumer watching
      // `updated_at` never mistakes a quiet service for a dead one, rare enough
      // that an idle service is not paying for a write every tick.
      heartbeatSeconds: Math.max(1, Math.floor(config.publish.stalenessThresholdSeconds / 3)),
      fullSyncSeconds: config.publish.fullSyncMinutes * 60,
      retentionSeconds: config.retentionDays * 86_400,
    })
  : undefined;
boot.info(publisher ? "turso publishing enabled" : "turso publishing disabled (not configured)");

// Bootstrap the remote read-model tables. Best-effort like every publish: an
// unreachable Turso must never stop the service from indexing and accruing, and
// the next publish tick retries the bootstrap on its own.
if (publisher) {
  try {
    await publisher.init();
    boot.info("turso read-model schema ready");
  } catch (e) {
    boot.error("turso schema bootstrap failed", { error: describeError(e) });
  }
}

const payoutLog = log.child("payout");

/**
 * The runner. Present whenever a seed is configured, INCLUDING when payouts are
 * disabled: the gate then refuses every release with a reason, which is a more
 * useful panel than one with no runner at all.
 */
const payoutRunner = payoutKeys
  ? createPayoutRunner({
      db,
      pool: mainnet,
      minPayout: config.minPayout,
      rails: config.rails,
      fee: config.maxFee,
      deadlineMinutes: config.payouts.deadlineMinutes,
      confirmationsRequired: config.payouts.confirmationsRequired,
      payoutsEnabled: config.payouts.enabled,
      keys: payoutKeys,
      nowEpochSeconds: () => Math.floor(Date.now() / 1000),
      log: payoutLog,
      onAlert: (kind, message) => openAlert(db, { kind, severity: "critical", message }),
    })
  : undefined;
boot.info(
  payoutRunner
    ? `payout runner ready in ${config.payouts.releaseMode} mode`
    : "no payout runner: PAYOUT_ACCOUNT_SEED is unset",
);

// True once the walker has finished catching up. Payout work is gated on it so
// replaying historical testnet blocks cannot trigger or advance a payout.
let chainCaughtUp = false;
// One payout pass at a time. The walker AWAITS onBlock, so the pass is
// dispatched rather than awaited: a mainnet failover must never stall testnet
// indexing, and a slow pass must never overlap itself.
let payoutBusy = false;

function onChainTick(): void {
  if (!payoutRunner || !chainCaughtUp || payoutBusy) return;
  payoutBusy = true;
  void (async () => {
    try {
      // Always reconcile: confirmations advance on mainnet whether or not a new
      // payout is due, and this is the only thing that moves a batch forward.
      const reconciled = await payoutRunner.tick();
      if (reconciled.kind !== "none" && reconciled.kind !== "waiting") {
        payoutLog.info("batch reconciled", reconciled);
      }
      if (config.payouts.releaseMode !== "auto") return;
      if (!payoutDue()) return;

      const outcome = await payoutRunner.release();
      if (outcome.kind !== "blocked") payoutLog.info("auto release", { outcome: outcome.kind });
    } catch (e) {
      // A throw here would otherwise be an unhandled rejection inside a
      // fire-and-forget task, which would take the process down.
      payoutLog.error("payout pass failed", { error: describeError(e) });
    } finally {
      payoutBusy = false;
    }
  })();
}

/** Whether the schedule says a cycle is owed, using the same clock as the panel. */
function payoutDue(): boolean {
  return computePayoutSchedule({
    enabled: config.payouts.enabled,
    paused: isPayoutsPaused(db),
    killSwitch: isKillSwitchTripped(db),
    lastRunAt: lastBatchCreatedAt(db),
    serviceStartedAt,
    intervalSeconds: config.payouts.intervalMinutes * 60,
    nowEpochSeconds: Math.floor(Date.now() / 1000),
  }).due;
}

const indexer = createIndexer({
  db,
  config,
  log: log.child("indexer"),
  walkerCachePath: paths.walkerCachePath,
  lookupMainnetAccount,
  isExcluded: () => false,
  // Payout work rides the chain heartbeat rather than a timer of its own: it
  // then cannot run while the service is not observing testnet, which is
  // exactly when it should not be paying for testnet work.
  onBlockObserved: () => onChainTick(),
  onCaughtUp: () => {
    chainCaughtUp = true;
    payoutLog.info("chain caught up; payout ticks enabled");
  },
});

const adminServer = createAdminServer({
  db,
  token: config.admin.token,
  host: config.admin.bindHost,
  port: config.admin.port,
  minPayout: config.minPayout,
  rails: config.rails,
  policy: config.policy,
  payoutSchedule: {
    enabled: config.payouts.enabled,
    intervalSeconds: config.payouts.intervalMinutes * 60,
    serviceStartedAt,
  },
  getHealth: () => healthMonitor.getLatest(),
  getChainHead: () => healthMonitor.getChainHead(),
  channels,
  log: log.child("admin"),
  simulate: (report) =>
    simulatePayout(report, {
      senderPublicKey: payoutPublicKey,
      fee: config.maxFee,
      deadlineMinutes: config.payouts.deadlineMinutes,
      // MAINNET: the reward is real SIGNA. Testnet is only where the work is
      // observed; it is not where anyone gets paid.
      sendToMany: (args) => mainnet.buildUnsignedMultiOut(args),
      sendToOne: (args) => mainnet.buildUnsignedSend(args),
    }),
  getForkState: () => forkMonitor?.getState(),
  runner: payoutRunner,
  releaseMode: config.payouts.releaseMode,
  getPayoutAccount: payoutAccount && (() => payoutAccount.get()),
});
boot.info("admin UI listening", { url: adminServer.url });

const publishLog = log.child("publish");

async function publishTick() {
  if (!publisher) return;
  try {
    const outcome = await publisher.publish(
      buildProjection(db, {
        nowEpochSeconds: Math.floor(Date.now() / 1000),
        chainDay: toChainDay(ChainTime.fromDate(new Date()).getChainTimestamp()),
        recentPayoutLimit: 20,
        // Every row published here is read again on every page view, so the
        // published view is windowed while the admin panel stays complete.
        minerActivitySince: Math.floor(Date.now() / 1000) - config.retentionDays * 86_400,
        payouts: {
          enabled: config.payouts.enabled,
          intervalSeconds: config.payouts.intervalMinutes * 60,
          serviceStartedAt,
        },
        policy: config.policy,
        minPayout: config.minPayout,
        // The head the health probe already keeps, republished so the page can
        // show the chain moving. Undefined before the first successful probe.
        chainHead: healthMonitor.getChainHead()?.block,
      }),
    );
    // Only full syncs are logged: ordinary ticks are usually no-ops now, and a
    // line per tick would bury everything else.
    if (outcome.fullSync) {
      publishLog.info("full sync", {
        miners: outcome.minersWritten,
        payouts: outcome.payoutsWritten,
        minersPruned: outcome.minersDeleted,
        payoutsPruned: outcome.payoutsDeleted,
      });
    } else if (!outcome.skipped) {
      publishLog.debug("published", {
        status: outcome.statusWritten,
        miners: outcome.minersWritten,
        payouts: outcome.payoutsWritten,
      });
    }
  } catch (e) {
    // Best-effort: the next tick republishes from live state, so a failure needs
    // no queue and must never stop indexing.
    publishLog.error("failed", { error: describeError(e) });
  }
}

healthMonitor.start();
forkMonitor?.start();
const publishTimer = setInterval(() => void publishTick(), config.publish.intervalSeconds * 1000);
const notifyTimer = setInterval(() => void notifier.flush(), 30_000);
const pruneTimer = setInterval(() => {
  const dropped = pruneLedger(db, Math.floor(Date.now() / 1000) - config.retentionDays * 86_400);
  log.child("retention").debug("pruned local ledger", { ...dropped });
}, 6 * 3_600_000);

/** Everything with a timer or a socket behind it. Shared by shutdown and hot reload. */
function stopBackgroundWork(): void {
  clearInterval(publishTimer);
  clearInterval(notifyTimer);
  clearInterval(pruneTimer);
  healthMonitor.stop();
  forkMonitor?.stop();
  adminServer.stop();
}

globalThis.__rewardsTeardown = () => {
  stopBackgroundWork();
  void indexer.stop();
};

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.child("shutdown").info(signal);
  globalThis.__rewardsTeardown = undefined;
  stopBackgroundWork();
  await indexer.stop();
  publisher?.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Logged, then left to fail. A process in an unknown state must not keep
// signing off on money, and pm2 restarts it cleanly — but the reason has to
// reach the log first, or a restart loop is silent.
process.on("unhandledRejection", (reason) => {
  log.error("unhandled promise rejection", { error: describeError(reason) });
});
process.on("uncaughtException", (e) => {
  log.error("uncaught exception; exiting", { error: describeError(e) });
  process.exit(1);
});

// Runs until stopped. walk() catches up, then listen() takes over.
await indexer.run();
