import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { getFreshAccount, upsertAccount } from "../../src/ledger/mainnetAccounts.ts";

let db: Ledger;
const TTL = { positiveSeconds: 86_400, negativeSeconds: 3_600 };
beforeEach(() => { db = openLedger(":memory:"); });

describe("mainnet account cache", () => {
  test("returns undefined when the account was never looked up", () => {
    expect(getFreshAccount(db, "acct-1", TTL, 1_000_000)).toBeUndefined();
  });
  test("returns a cached active account within its TTL", () => {
    upsertAccount(db, { accountId: "acct-1", publicKey: "pk", isActive: true }, 1_000_000);
    const hit = getFreshAccount(db, "acct-1", TTL, 1_000_000 + 3_600);
    expect(hit?.isActive).toBe(true);
    expect(hit?.publicKey).toBe("pk");
  });
  test("treats an active entry as stale once the positive TTL passes", () => {
    upsertAccount(db, { accountId: "acct-1", publicKey: "pk", isActive: true }, 1_000_000);
    expect(getFreshAccount(db, "acct-1", TTL, 1_000_000 + 86_401)).toBeUndefined();
  });
  test("NEGATIVE ENTRIES EXPIRE SOONER so a newly activated account starts earning quickly", () => {
    upsertAccount(db, { accountId: "acct-1", publicKey: null, isActive: false }, 1_000_000);
    expect(getFreshAccount(db, "acct-1", TTL, 1_000_000 + 3_599)?.isActive).toBe(false);
    expect(getFreshAccount(db, "acct-1", TTL, 1_000_000 + 3_601)).toBeUndefined();
  });
  test("upsert overwrites a previous entry rather than duplicating", () => {
    upsertAccount(db, { accountId: "acct-1", publicKey: null, isActive: false }, 1_000_000);
    upsertAccount(db, { accountId: "acct-1", publicKey: "pk", isActive: true }, 1_000_100);
    const rows = db.query("SELECT COUNT(*) AS c FROM mainnet_accounts").get() as { c: number };
    expect(rows.c).toBe(1);
    expect(getFreshAccount(db, "acct-1", TTL, 1_000_100)?.isActive).toBe(true);
  });
});
