import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "./schema.ts";
import type { AppConfig } from "./schema.ts";

/**
 * Written once by scripts/setup-volume.ts onto the real data volume.
 * Its absence means the volume is not mounted, however plausible the path looks.
 */
export const SENTINEL_FILENAME = ".volume-ok";

export class VolumeNotMountedError extends Error {
  constructor(dataDir: string) {
    super(
      `Data volume not mounted: ${join(dataDir, SENTINEL_FILENAME)} is missing.\n` +
        `Refusing to start, because opening SQLite here would silently create an\n` +
        `empty ledger and the entire block history would be re-accrued.\n` +
        `If the volume really is mounted and this is first-time setup, run:\n` +
        `  DATA_DIR=${dataDir} bun run scripts/setup-volume.ts`,
    );
    this.name = "VolumeNotMountedError";
  }
}

/**
 * Verifies the data directory is the real volume before anything opens a database.
 *
 * A bare existsSync(dataDir) check is NOT sufficient: an unmounted mountpoint is
 * an ordinary empty directory that exists and is writable. Only a file placed on
 * the volume itself distinguishes the two.
 */
export function assertDataVolumeMounted(dataDir: string): void {
  if (!existsSync(join(dataDir, SENTINEL_FILENAME))) {
    throw new VolumeNotMountedError(dataDir);
  }
}

export interface LedgerPaths {
  databasePath: string;
  walkerCachePath: string;
}

/**
 * Both caches live on the same volume, always. Split across volumes they can
 * desynchronise in the dangerous direction (walker cache ahead on the SD card,
 * ledger gone with the unmounted HDD), which silently SKIPS blocks. Kept
 * together they fail together, which the sentinel then catches.
 */
export function resolvePaths(cfg: AppConfig): LedgerPaths {
  return {
    databasePath: join(cfg.dataDir, "rewards.sqlite"),
    walkerCachePath: join(cfg.dataDir, "chainwalker.cache.json"),
  };
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): AppConfig {
  const cfg = parseConfig(env);
  assertDataVolumeMounted(cfg.dataDir);
  return cfg;
}
