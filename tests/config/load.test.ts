import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDataVolumeMounted,
  VolumeNotMountedError,
  SENTINEL_FILENAME,
} from "../../src/config/load.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewards-vol-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("assertDataVolumeMounted", () => {
  test("passes when the sentinel file is present", () => {
    writeFileSync(join(dir, SENTINEL_FILENAME), "ok");
    expect(() => assertDataVolumeMounted(dir)).not.toThrow();
  });

  test("throws when the directory exists but the sentinel is missing", () => {
    // Exactly the unmounted-HDD case: the mountpoint directory exists and is
    // writable, but it is not the real volume.
    expect(() => assertDataVolumeMounted(dir)).toThrow(VolumeNotMountedError);
  });

  test("throws when the directory does not exist at all", () => {
    expect(() => assertDataVolumeMounted(join(dir, "nope"))).toThrow(VolumeNotMountedError);
  });

  test("error message names the sentinel path so the operator can fix it", () => {
    try {
      assertDataVolumeMounted(dir);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as Error).message).toContain(SENTINEL_FILENAME);
      expect((e as Error).message).toContain(dir);
    }
  });

  test("an empty nested mountpoint still fails", () => {
    const nested = join(dir, "signum-rewards");
    mkdirSync(nested);
    expect(() => assertDataVolumeMounted(nested)).toThrow(VolumeNotMountedError);
  });
});
