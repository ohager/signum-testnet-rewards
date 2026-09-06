import { test, expect, describe } from "bun:test";
import { createMainnetPool, AllNodesFailedError } from "../../src/chain/mainnetPool.ts";
import type { MainnetNodeClient } from "../../src/chain/mainnetPool.ts";
import type { UnsignedTransaction } from "@signumjs/core";

const unsigned = (host: string): UnsignedTransaction => ({
  signatureHash: `hash-${host}`,
  unsignedTransactionBytes: `bytes-${host}`,
  transactionJSON: { builtBy: host },
  broadcasted: false,
  requestProcessingTime: 1,
});

const unused = (what: string) => () => Promise.reject(new Error(`${what} not used in this test`));

/** Fills the payout half of the interface for tests that only exercise lookups. */
const noPayouts = {
  buildUnsignedMultiOut: unused("buildUnsignedMultiOut"),
  buildUnsignedSend: unused("buildUnsignedSend"),
  sendMultiOut: unused("sendMultiOut"),
  sendSingle: unused("sendSingle"),
  getTransaction: unused("getTransaction"),
};

const node = (
  opts: { fails?: boolean; publicKey?: string | null; balance?: string; host?: string },
): MainnetNodeClient => ({
  getAccount: async (id: string) => {
    if (opts.fails) throw new Error("node down");
    return { account: id, publicKey: opts.publicKey ?? null, balanceNQT: opts.balance ?? "0" };
  },
  buildUnsignedMultiOut: async () => {
    if (opts.fails) throw new Error("node down");
    return unsigned(opts.host ?? "node");
  },
  buildUnsignedSend: async () => {
    if (opts.fails) throw new Error("node down");
    return unsigned(opts.host ?? "node");
  },
  sendMultiOut: unused("sendMultiOut"),
  sendSingle: unused("sendSingle"),
  getTransaction: unused("getTransaction"),
});

describe("createMainnetPool", () => {
  test("uses the first healthy node", async () => {
    const pool = createMainnetPool(["a", "b"], (host) =>
      host === "a" ? node({ publicKey: "pk-a" }) : node({ publicKey: "pk-b" }),
    );
    expect((await pool.getAccount("123"))?.publicKey).toBe("pk-a");
  });

  test("FAILOVER: falls through to the next node when the first throws", async () => {
    const pool = createMainnetPool(["a", "b"], (host) =>
      host === "a" ? node({ fails: true }) : node({ publicKey: "pk-b" }),
    );
    expect((await pool.getAccount("123"))?.publicKey).toBe("pk-b");
  });

  test("throws AllNodesFailedError only when every node fails", async () => {
    const pool = createMainnetPool(["a", "b"], () => node({ fails: true }));
    await expect(pool.getAccount("123")).rejects.toThrow(AllNodesFailedError);
  });

  test("STICKY: after a failover, later calls start from the node that worked", async () => {
    let aCalls = 0;
    const pool = createMainnetPool(["a", "b"], (host) => {
      if (host === "a") {
        return { getAccount: async () => { aCalls++; throw new Error("node down"); }, ...noPayouts };
      }
      return node({ publicKey: "pk-b" });
    });
    await pool.getAccount("1");
    await pool.getAccount("2");
    await pool.getAccount("3");
    expect(aCalls).toBe(1);
  });

  test("reports a missing account as undefined rather than an error", async () => {
    const pool = createMainnetPool(["a"], () => ({
      getAccount: async () => {
        const err = new Error("Unknown account") as Error & { data?: { errorCode: number } };
        err.data = { errorCode: 5 };
        throw err;
      },
      ...noPayouts,
    }));
    expect(await pool.getAccount("123")).toBeUndefined();
  });

  test("a missing account does NOT trigger failover across the whole pool", async () => {
    // Otherwise every lookup for an unregistered miner would walk every node.
    let attempts = 0;
    const pool = createMainnetPool(["a", "b", "c"], () => ({
      getAccount: async () => {
        attempts++;
        const err = new Error("Unknown account") as Error & { data?: { errorCode: number } };
        err.data = { errorCode: 5 };
        throw err;
      },
      ...noPayouts,
    }));
    await pool.getAccount("123");
    expect(attempts).toBe(1);
  });
});

describe("building payouts on mainnet", () => {
  // Miners forge on testnet, but the reward is real SIGNA. A payout built
  // against the testnet node would be a transaction in a currency nobody wants,
  // which is why this lives on the mainnet pool at all.
  const args = {
    recipientAmounts: [
      { recipient: "acct-1", amountNQT: "250000000" },
      { recipient: "acct-2", amountNQT: "250000000" },
    ],
    senderPublicKey: "pubkey",
    feePlanck: "1000000",
    deadline: 30,
  };

  test("returns the unsigned transaction the node built", async () => {
    const pool = createMainnetPool(["a"], () => node({ host: "a" }));

    const tx = await pool.buildUnsignedMultiOut(args);
    expect(tx.unsignedTransactionBytes).toBe("bytes-a");
    expect(tx.broadcasted).toBe(false);
  });

  test("FAILOVER IS SAFE HERE: no key is passed, so a retry cannot pay twice", async () => {
    const pool = createMainnetPool(["dead", "alive"], (host) =>
      node({ fails: host === "dead", host }),
    );

    expect((await pool.buildUnsignedMultiOut(args)).transactionJSON).toEqual({ builtBy: "alive" });
  });

  test("every node failing surfaces as AllNodesFailedError", async () => {
    const pool = createMainnetPool(["a", "b"], () => node({ fails: true }));

    await expect(pool.buildUnsignedMultiOut(args)).rejects.toBeInstanceOf(AllNodesFailedError);
  });

  test("the single-recipient fallback goes to mainnet too", async () => {
    const pool = createMainnetPool(["a"], () => node({ host: "a" }));

    const tx = await pool.buildUnsignedSend({
      recipientId: "acct-1", amountPlanck: "500000000",
      senderPublicKey: "pubkey", feePlanck: "1000000", deadline: 30,
    });
    expect(tx.signatureHash).toBe("hash-a");
  });
});
