import { test, expect, describe } from "bun:test";
import { Address, AddressPrefix } from "@signumjs/core";
import { Crypto } from "@signumjs/crypto";
import { NodeJSCryptoAdapter } from "@signumjs/crypto/adapters";
import { createPayoutAccountWatcher } from "../../src/payout/payoutAccount.ts";
import type { MainnetAccountResult } from "../../src/chain/mainnetPool.ts";

// Deriving an account id from a public key hashes it, so SignumJS needs its
// crypto adapter. main.ts installs the same one at boot.
Crypto.init(new NodeJSCryptoAdapter());

// A real 64-hex public key. The address is derived from it, so an invented
// value would not produce a checkable address.
const PUBLIC_KEY = "0".repeat(63) + "1";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function watcher(
  getAccount: (id: string) => Promise<MainnetAccountResult | undefined>,
  opts: { ttlSeconds?: number; now?: () => number } = {},
) {
  return createPayoutAccountWatcher({
    publicKey: PUBLIC_KEY,
    getAccount,
    ttlSeconds: opts.ttlSeconds ?? 60,
    now: opts.now,
  });
}

const account = (balanceNQT: string): MainnetAccountResult => ({
  account: "1",
  publicKey: PUBLIC_KEY,
  balanceNQT,
});

describe("payout account watcher", () => {
  test("reports the MAINNET address, not the testnet one", () => {
    const view = watcher(async () => undefined).get();
    const expected = Address.fromPublicKey(PUBLIC_KEY, AddressPrefix.MainNet);

    expect(view.accountRS).toBe(expected.getReedSolomonAddress());
    expect(view.accountRS.startsWith("S-")).toBe(true);
    expect(view.accountId).toBe(expected.getNumericId());
  });

  test("knows the account before any lookup has succeeded", () => {
    // The identity must never depend on the network: an operator asking "which
    // account do we pay from" gets an answer even with every mainnet node down.
    const view = watcher(async () => {
      throw new Error("all nodes failed");
    }).get();

    expect(view.accountId).not.toBe("");
    expect(view.balancePlanck).toBeNull();
    expect(view.checkedAt).toBeNull();
  });

  test("the first read does not block on the lookup", async () => {
    const w = watcher(async () => account("500"));

    expect(w.get().balancePlanck).toBeNull();
    await settle();
    expect(w.get().balancePlanck).toBe("500");
  });

  test("serves the cached balance until the TTL expires", async () => {
    let calls = 0;
    let clock = 1_000;
    const w = watcher(
      async () => {
        calls++;
        return account(String(calls));
      },
      { ttlSeconds: 60, now: () => clock },
    );

    w.get();
    await settle();
    expect(w.get().balancePlanck).toBe("1");

    clock += 59;
    w.get();
    await settle();
    expect(calls).toBe(1);

    clock += 1;
    w.get();
    await settle();
    expect(calls).toBe(2);
    expect(w.get().balancePlanck).toBe("2");
  });

  test("a missing account reads as zero, not as an error", async () => {
    const w = watcher(async () => undefined);

    w.get();
    await settle();
    const view = w.get();

    expect(view.existsOnChain).toBe(false);
    expect(view.balancePlanck).toBe("0");
    expect(view.error).toBeNull();
  });

  test("a failed lookup keeps the last balance and reports the error", async () => {
    let fail = false;
    let clock = 1_000;
    const w = watcher(
      async () => {
        if (fail) throw new Error("all nodes failed");
        return account("777");
      },
      { ttlSeconds: 10, now: () => clock },
    );

    w.get();
    await settle();
    expect(w.get().balancePlanck).toBe("777");

    fail = true;
    clock += 10;
    w.get();
    await settle();

    const view = w.get();
    // Blanking the balance would read as "the account was emptied".
    expect(view.balancePlanck).toBe("777");
    expect(view.error).toContain("all nodes failed");
    expect(view.checkedAt).toBe(1_000);
  });

  test("a persistent failure retries on the TTL, not on every read", async () => {
    let calls = 0;
    let clock = 1_000;
    const w = watcher(
      async () => {
        calls++;
        throw new Error("down");
      },
      { ttlSeconds: 30, now: () => clock },
    );

    for (let i = 0; i < 5; i++) {
      w.get();
      await settle();
    }
    expect(calls).toBe(1);

    clock += 30;
    w.get();
    await settle();
    expect(calls).toBe(2);
  });

  test("overlapping reads share one in-flight lookup", async () => {
    let calls = 0;
    const w = watcher(async () => {
      calls++;
      await settle();
      return account("1");
    });

    w.get();
    w.get();
    w.get();
    await settle();
    await settle();

    expect(calls).toBe(1);
  });

  test("a lookup error never escapes get()", () => {
    const w = watcher(async () => {
      throw new Error("boom");
    });
    expect(() => w.get()).not.toThrow();
  });
});
