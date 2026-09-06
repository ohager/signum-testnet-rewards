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
import { toChainDay } from "./domain/chainDay.ts";
import { ChainTime } from "@signumjs/util";
import { pruneLedger } from "./ledger/retention.ts";

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

const indexer = createIndexer({
  db,
  config,
  walkerCachePath: paths.walkerCachePath,
  lookupMainnetAccount,
  isExcluded: () => false,
  onBlockObserved: () => {},
});

const adminServer = createAdminServer({
  db,
  token: config.admin.token,
  host: config.admin.bindHost,
  port: config.admin.port,
  minPayout: config.minPayout,
  rails: config.rails,
  globalDailyBudget: config.policy.globalDailyBudget,
  payoutSchedule: {
    enabled: config.payouts.enabled,
    intervalSeconds: config.payouts.intervalMinutes * 60,
    serviceStartedAt,
  },
  getHealth: () => healthMonitor.getLatest(),
  getChainHead: () => healthMonitor.getChainHead(),
  getForkState: () => forkMonitor?.getState(),
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
        globalDailyBudget: config.policy.globalDailyBudget,
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

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.child("shutdown").info(signal);
  clearInterval(publishTimer);
  clearInterval(notifyTimer);
  clearInterval(pruneTimer);
  healthMonitor.stop();
  forkMonitor?.stop();
  adminServer.stop();
  await indexer.stop();
  publisher?.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Runs until stopped. walk() catches up, then listen() takes over.
await indexer.run();
