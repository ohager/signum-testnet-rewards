/**
 * One-time setup: marks the data directory as the real volume.
 * Run this ONLY when the HDD is confirmed mounted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SENTINEL_FILENAME } from "../src/config/load.ts";

const dataDir = Bun.env.DATA_DIR;
if (!dataDir) {
  console.error("DATA_DIR is not set");
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
const sentinel = join(dataDir, SENTINEL_FILENAME);
writeFileSync(sentinel, `created ${new Date().toISOString()}\n`);
console.log(`Wrote ${sentinel}`);
console.log("Verify this file lives on the HDD, not the SD card:");
console.log(`  df -h ${dataDir}`);
