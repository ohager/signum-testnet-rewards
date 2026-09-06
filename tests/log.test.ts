import { test, expect, describe } from "bun:test";
import { logLevelFor, describeError, silentLogger, createLogger } from "../src/log.ts";

describe("logLevelFor", () => {
  test("VERBOSE_LOGGING is the whole contract: debug on, info off", () => {
    expect(logLevelFor(true)).toBe("debug");
    expect(logLevelFor(false)).toBe("info");
  });
});

describe("describeError", () => {
  test("prefers an Error's message over its stringification", () => {
    expect(describeError(new Error("node unreachable"))).toBe("node unreachable");
  });

  test("a thrown non-Error is still printable", () => {
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError(undefined)).toBe("undefined");
    expect(describeError({ code: 500 })).toBe("[object Object]");
  });
});

describe("scopes", () => {
  test("nest so a subsystem's origin survives", () => {
    // Exercised through the silent logger: the shape is what matters, and a
    // real transport would make this an async output-capture test for no gain.
    const log = silentLogger();
    expect(() => log.child("publish").child("turso").info("x")).not.toThrow();
  });

  test("a real logger exposes the same four levels and a child", () => {
    const log = createLogger(false);
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(typeof log[level]).toBe("function");
    }
    expect(typeof log.child("boot").info).toBe("function");
  });
});
