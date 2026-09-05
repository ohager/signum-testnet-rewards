import { test, expect, describe } from "bun:test";
import { decideEligibility } from "../../src/eligibility/eligibility.ts";

describe("decideEligibility", () => {
  test("eligible when the mainnet account is active with a matching public key", () => {
    expect(decideEligibility({
      generatorPublicKey: "abc123", excluded: false,
      mainnetAccount: { isActive: true, publicKey: "abc123" },
    })).toEqual({ kind: "eligible" });
  });
  test("ineligible when no mainnet account exists", () => {
    expect(decideEligibility({
      generatorPublicKey: "abc123", excluded: false, mainnetAccount: undefined,
    })).toEqual({ kind: "ineligible", status: "skipped_no_mainnet_account" });
  });
  test("ineligible when the mainnet account exists but has no public key set", () => {
    expect(decideEligibility({
      generatorPublicKey: "abc123", excluded: false,
      mainnetAccount: { isActive: false, publicKey: null },
    })).toEqual({ kind: "ineligible", status: "skipped_no_mainnet_account" });
  });
  test("ANOMALY: ineligible when public keys differ despite the same account id", () => {
    expect(decideEligibility({
      generatorPublicKey: "abc123", excluded: false,
      mainnetAccount: { isActive: true, publicKey: "totally-different" },
    })).toEqual({ kind: "ineligible", status: "skipped_pubkey_mismatch" });
  });
  test("public key comparison ignores case, since hex casing varies by source", () => {
    expect(decideEligibility({
      generatorPublicKey: "ABC123", excluded: false,
      mainnetAccount: { isActive: true, publicKey: "abc123" },
    })).toEqual({ kind: "eligible" });
  });
  test("exclusion wins over everything else", () => {
    expect(decideEligibility({
      generatorPublicKey: "abc123", excluded: true,
      mainnetAccount: { isActive: true, publicKey: "abc123" },
    })).toEqual({ kind: "ineligible", status: "skipped_excluded" });
  });
});
