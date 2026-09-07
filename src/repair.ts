import { existsSync } from "node:fs";
import { LedgerClientFactory } from "@signumjs/core";
import { loadConfig, resolvePaths } from "./config/load.ts";
import { openLedger } from "./ledger/db.ts";
import { createLogger } from "./log.ts";
import { createReorgAuditor } from "./indexer/reorgAudit.ts";
import { createBlockHandler } from "./indexer/blockHandler.ts";
import { getFreshAccount } from "./ledger/mainnetAccounts.ts";
import { setReorgAuditHeight, getReorgAuditHeight, isKillSwitchTripped } from "./ledger/state.ts";
import { listOpenAlerts, listUnnotifiedAlerts } from "./ledger/alerts.ts";
import { countByStatus, lastIndexedBlock } from "./ledger/blockRewards.ts";

/**
 * Re-audits a range of already-indexed heights against the testnet node.
 *
 * The running service verifies each height once as it settles, and scrubs a
 * rolling window behind that. Neither reaches back over history — so a reorg
 * that happened before this code existed leaves stale accruals nothing will
 * ever notice. This is how that damage gets cleaned up, once.
 *
 * Run with `bun run repair -- --from <height>`. Flags:
 *   --from <height>  lowest height to re-verify (required)
 *   --to <height>    highest; defaults to the last indexed block
 *   --dry-run        report what would change, then roll it back
 *   --yes            skip the confirmation
 *
 * Expect it to trip the kill switch if it finds an orphan that was already
 * paid. That is the point: nothing here can recall SIGNA that has left, so the
 * next payout waits for a human who has seen the numbers.
 */
const argv = Bun.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string): boolean => argv.includes(name);

const log = createLogger(false).child("repair");
const dryRun = has("--dry-run");

const from = Number(flag("--from"));
if (!Number.isInteger(from) || from < 0) {
  log.error("--from <height> is required", { got: flag("--from") ?? "(nothing)" });
  process.exit(1);
}

const config = loadConfig();
const paths = resolvePaths(config);

// Repairing under a running service would have the two of them re-scoring the
// same heights against different views of the caps.
if (await isListening(config.admin.bindHost, config.admin.port)) {
  log.error("the service appears to be running; stop it first", {
    admin: `${config.admin.bindHost}:${config.admin.port}`,
  });
  process.exit(1);
}

// openLedger creates on demand, which is right for a service starting up and
// exactly wrong here: a mistyped DATA_DIR, or a ledger moved aside for a backup,
// would otherwise produce a pristine empty database and the baffling report that
// there is nothing to repair.
if (!existsSync(paths.databasePath)) {
  log.error("no ledger at that path; refusing to create one", {
    databasePath: paths.databasePath,
    dataDir: config.dataDir,
  });
  log.error("if you moved it aside for a backup, move it back (or copy it) first");
  process.exit(1);
}

const db = openLedger(paths.databasePath);
const tip = lastIndexedBlock(db)?.height;
if (tip === undefined) {
  log.error("nothing indexed; nothing to repair");
  process.exit(1);
}
const to = Number(flag("--to") ?? tip);

const ledger = LedgerClientFactory.createClient({ nodeHost: config.chain.testnetNodeHost });
const handler = createBlockHandler({
  db,
  policy: config.policy,
  // Served from the cache the service already built. A repair must not depend
  // on mainnet being reachable, and every account in this range is in there.
  lookupMainnetAccount: async (accountId) => {
    const cached = getFreshAccount(
      db,
      accountId,
      { positiveSeconds: Number.MAX_SAFE_INTEGER, negativeSeconds: Number.MAX_SAFE_INTEGER },
      Math.floor(Date.now() / 1000),
    );
    return cached ? { isActive: cached.isActive, publicKey: cached.publicKey } : undefined;
  },
  isExcluded: () => false,
});

const auditor = createReorgAuditor({
  db,
  depth: config.health.forkCheckDepth,
  canonicalBlockIdAt: async (height) => (await ledger.block.getBlockByHeight(height, false)).block,
  reindex: async (height) => {
    await handler(await ledger.block.getBlockByHeight(height, false));
  },
  nodeHeadHeight: async () => (await ledger.network.getBlockchainStatus()).numberOfBlocks - 1,
  indexerPosition: async () => undefined,
  // The walker is stopped; its cache is left alone and the next start resumes
  // from wherever it was.
  resumeIndexingFrom: async () => {},
  log: log.child("audit"),
});

log.info("before", { ...countByStatus(db), auditWatermark: getReorgAuditHeight(db) ?? "(unset)" });
log.warn("about to re-verify", { from, to, heights: to - from + 1, dryRun });

if (!has("--yes") && !dryRun) {
  const answer = prompt("Type 'repair' to continue:");
  if (answer !== "repair") {
    log.info("aborted; nothing was changed");
    db.close();
    process.exit(1);
  }
}

// One transaction so a network failure part-way through cannot leave half the
// range rolled back and the other half not, and so --dry-run has something to
// undo. SQLite holds the whole thing; the range is thousands of rows at most.
db.run("BEGIN");
let repaired = 0;
let unchecked = 0;
try {
  for (let height = from; height <= to; height++) {
    const outcome = await auditor.auditHeight(height);
    if (outcome.kind === "reorged") {
      repaired++;
      log.warn("replaced block", {
        height,
        wasRecorded: outcome.orphaned.join(", "),
        nowCanonical: outcome.canonicalBlockId,
        alreadyPaid: outcome.paid.length > 0,
      });
    } else if (outcome.kind === "unchecked") {
      unchecked++;
      log.error("could not verify", { height, reason: outcome.reason });
    }
  }
  auditor.flushNotices();
} catch (e) {
  db.run("ROLLBACK");
  throw e;
}

if (dryRun) {
  db.run("ROLLBACK");
  log.info("dry run: every change above was rolled back");
} else {
  db.run("COMMIT");
  log.info("after", { ...countByStatus(db) });
  log.info("queued notifications", {
    kinds: listUnnotifiedAlerts(db).map((a) => a.kind).join(", ") || "(none)",
  });
  log.info("open alerts", {
    kinds: listOpenAlerts(db).map((a) => a.kind).join(", ") || "(none)",
  });
  if (isKillSwitchTripped(db)) {
    log.warn(
      "PAYOUTS ARE HALTED: an orphaned accrual had already been paid. " +
        "Review the numbers, then clear the kill switch in the admin panel.",
    );
  }
}

log.info("done", { repaired, unchecked, range: `${from}-${to}` });
db.close();

/** A connect that succeeds means something is bound to the admin port. */
async function isListening(host: string, port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: host === "0.0.0.0" ? "127.0.0.1" : host,
      port,
      socket: { data() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}
