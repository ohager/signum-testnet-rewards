import { test, expect, describe } from "bun:test";
import { ChainTime } from "@signumjs/util";
import { toChainDay } from "../../src/domain/chainDay.ts";

describe("toChainDay", () => {
  test("converts a chain timestamp to its UTC calendar day", () => {
    const ts = ChainTime.fromDate(new Date("2026-03-14T12:00:00Z")).getChainTimestamp();
    expect(toChainDay(ts)).toBe("2026-03-14");
  });

  test("uses UTC, not local time, at day boundaries", () => {
    const justBefore = ChainTime.fromDate(new Date("2026-03-14T23:59:59Z")).getChainTimestamp();
    const justAfter = ChainTime.fromDate(new Date("2026-03-15T00:00:01Z")).getChainTimestamp();
    expect(toChainDay(justBefore)).toBe("2026-03-14");
    expect(toChainDay(justAfter)).toBe("2026-03-15");
  });

  test("is stable: same input always yields same output", () => {
    const ts = ChainTime.fromDate(new Date("2026-01-01T00:00:00Z")).getChainTimestamp();
    expect(toChainDay(ts)).toBe(toChainDay(ts));
  });
});
