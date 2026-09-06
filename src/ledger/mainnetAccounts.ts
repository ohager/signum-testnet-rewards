import type { Ledger } from "./db.ts";
import type { MainnetAccountFacts } from "../eligibility/eligibility.ts";

export interface AccountTtl {
  positiveSeconds: number;
  negativeSeconds: number;
}

export interface CachedAccount extends MainnetAccountFacts {
  accountId: string;
  lastCheckedAt: number;
}

/**
 * Returns a cached lookup only if it is still fresh.
 *
 * Negative results expire much sooner than positive ones: a miner who activates
 * their mainnet account should start earning within the hour rather than waiting
 * out a full positive TTL.
 */
export function getFreshAccount(
  db: Ledger,
  accountId: string,
  ttl: AccountTtl,
  nowEpochSeconds: number,
): CachedAccount | undefined {
  const row = db
    .query(
      `SELECT account_id, public_key, is_active, last_checked_at
         FROM mainnet_accounts WHERE account_id = ?1`,
    )
    .get(accountId) as Record<string, unknown> | null;
  if (!row) return undefined;

  const isActive = (row.is_active as number) === 1;
  const lastCheckedAt = row.last_checked_at as number;
  const maxAge = isActive ? ttl.positiveSeconds : ttl.negativeSeconds;
  if (nowEpochSeconds - lastCheckedAt > maxAge) return undefined;

  return {
    accountId: row.account_id as string,
    publicKey: (row.public_key as string | null) ?? null,
    isActive,
    lastCheckedAt,
  };
}

export function upsertAccount(
  db: Ledger,
  facts: { accountId: string; publicKey: string | null; isActive: boolean },
  nowEpochSeconds: number,
): void {
  db.query(
    `INSERT INTO mainnet_accounts (account_id, public_key, is_active, last_checked_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(account_id) DO UPDATE SET
       public_key      = excluded.public_key,
       is_active       = excluded.is_active,
       last_checked_at = excluded.last_checked_at`,
  ).run(facts.accountId, facts.publicKey, facts.isActive ? 1 : 0, nowEpochSeconds);
}
