import { test, expect, describe } from "bun:test";
import { toReedSolomon } from "../../src/domain/address.ts";

describe("toReedSolomon", () => {
  test("renders a numeric account id as a testnet address", () => {
    expect(toReedSolomon("4325295135044374377")).toBe("TS-R5VB-2B6J-2N8C-5BN3S");
  });

  test("USES THE TESTNET PREFIX: the mainnet form would point at the wrong chain", () => {
    expect(toReedSolomon("4325295135044374377").startsWith("TS-")).toBe(true);
  });

  test("is stable across calls, so the memo cannot drift", () => {
    expect(toReedSolomon("6502115112683865257")).toBe(toReedSolomon("6502115112683865257"));
  });

  test("AN UNRENDERABLE ID IS SHOWN AS ITSELF, NEVER THROWN", () => {
    expect(toReedSolomon("not-an-account")).toBe("not-an-account");
    expect(toReedSolomon("")).toBe("");
  });
});
