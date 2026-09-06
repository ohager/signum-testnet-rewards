import { createClient } from "@libsql/client";
import { loadConfig, resolvePaths } from "./config/load.ts";
import { openLedger } from "./ledger/db.ts";
import { createLogger, describeError } from "./log.ts";
import { assessReset, wipeRemote, removeLocalFiles } from "./ops/reset.ts";

/**
 * Resets the service to a clean slate: local ledger, walker cache, and the
 * published read-model.
 *
 * Run with `bun run reset`. Flags:
 *   --yes    skip the interactive confirmation (for scripts)
 *   --force  proceed even when batches exist that are not provably dead
 *
 * ORDERING IS DELIBERATE: the remote is emptied BEFORE the local files. If the
 * remote wipe fails, nothing local has been touched and the two are still
 * consistent. The other order would leave the published site holding rows that
 * no future tick can remove -- the publisher only upserts, and its retention
 * sweep deliberately keeps any miner still owed money.
 */
const argv = new Set(Bun.argv.slice(2));
const assumeYes = argv.has("--yes") || argv.has("-y");
const force = argv.has("--force");

const log = createLogger(false).child("reset");

const config = loadConfig();
const paths = resolvePaths(config);

// A reset while the service is running would delete files out from under an
// open SQLite handle and leave the walker writing its cache back afterwards.
const adminUp = await isListening(config.admin.bindHost, config.admin.port);
if (adminUp) {
  log.error("the service appears to be running", {
    admin: `${config.admin.bindHost}:${config.admin.port}`,
  });
  log.error("stop it first, e.g. `pm2 stop signum-testnet-rewards`");
  process.exit(1);
}

const db = openLedger(paths.databasePath);
const assessment = assessReset(db);

if (!assessment.safe) {
  log.error("refusing to reset", { reason: assessment.reason });
  for (const b of assessment.batches) {
    log.error("blocking batch", {
      id: b.id,
      status: b.status,
      txId: b.txId ?? "(none recorded)",
      totalPlanck: b.totalPlanck,
    });
  }
  if (!force) {
    log.error(
      "Check those transactions on a mainnet explorer. If they really did not pay, " +
        "re-run with --force. Doing so while any of them DID pay will credit those " +
        "rewards again on the next cycle.",
    );
    db.close();
    process.exit(1);
  }
  log.warn("--force given: proceeding despite batches that are not provably dead");
}

if (!assumeYes) {
  log.warn("about to delete", {
    ledger: paths.databasePath,
    walkerCache: paths.walkerCachePath,
    remote: config.publish.turso ? "status, miners, payouts" : "(turso not configured)",
  });
  const answer = prompt("Type 'reset' to continue:");
  if (answer !== "reset") {
    log.info("aborted; nothing was changed");
    db.close();
    process.exit(1);
  }
}

// The local handle must be closed before the files are unlinked.
db.close();

if (config.publish.turso) {
  const client = createClient({
    url: config.publish.turso.databaseUrl,
    authToken: config.publish.turso.authToken,
  });
  try {
    const tables = await wipeRemote({
      batch: (statements) => client.batch(statements, "write"),
    });
    log.info("published read-model emptied", { tables: tables.join(", ") });
  } catch (e) {
    // Abort BEFORE touching local state: an empty local ledger beside a
    // populated remote is the divergence this command exists to prevent.
    log.error("remote wipe failed; local files left untouched", { error: describeError(e) });
    process.exit(1);
  } finally {
    client.close();
  }
} else {
  log.info("turso not configured; nothing published to clear");
}

const removed = removeLocalFiles(paths);
log.info("local state removed", { files: removed.length ? removed.join(", ") : "(none present)" });
log.info("done — the next start will re-index from START_HEIGHT", {
  startHeight: config.chain.startHeight,
});

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
