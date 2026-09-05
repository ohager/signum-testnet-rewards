import { test, expect, describe } from "bun:test";
import { createMainnetPool, AllNodesFailedError } from "../../src/chain/mainnetPool.ts";
import type { MainnetNodeClient } from "../../src/chain/mainnetPool.ts";

const node = (opts: { fails?: boolean; publicKey?: string | null; balance?: string }): MainnetNodeClient => ({
  getAccount: async (id: string) => {
    if (opts.fails) throw new Error("node down");
    return { account: id, publicKey: opts.publicKey ?? null, balanceNQT: opts.balance ?? "0" };
  },
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
        return { getAccount: async () => { aCalls++; throw new Error("node down"); } };
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
    }));
    await pool.getAccount("123");
    expect(attempts).toBe(1);
  });
});
