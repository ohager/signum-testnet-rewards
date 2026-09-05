import { Amount } from "@signumjs/util";
import type { RewardPolicyConfig } from "../domain/policy.ts";
import type { RailsConfig } from "../domain/rails.ts";
import { toPlanckInt, MoneyError } from "../domain/money.ts";

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export interface AppConfig {
  dataDir: string;
  policy: RewardPolicyConfig;
  rails: RailsConfig;
  minPayout: Amount;
  maxFee: Amount;
  minWalletBalance: Amount;
  chain: {
    testnetNodeHost: string;
    testnetWsUrl: string;
    mainnetNodeHosts: string[];
    startHeight: number;
    blockOffset: number;
    walkerIntervalSeconds: number;
  };
  payouts: {
    enabled: boolean;
    intervalMinutes: number;
    deadlineMinutes: number;
    confirmationsRequired: number;
    accountSeed: string | undefined;
  };
  health: {
    stallThresholdMinutes: number;
    minPeers: number;
    syncLagBlocks: number;
    alertOpenAfterChecks: number;
    alertCloseAfterChecks: number;
  };
  publish: {
    /** Absent means publishing is disabled; the service still indexes and alerts. */
    turso?: { databaseUrl: string; authToken: string };
    intervalSeconds: number;
    stalenessThresholdSeconds: number;
    accountTtlPositiveSeconds: number;
    accountTtlNegativeSeconds: number;
  };
  notify: {
    telegram?: { botToken: string; chatId: string };
    discord?: { webhookUrl: string };
    email?: { resendApiKey: string; to: string };
  };
  admin: { bindHost: string; port: number; token: string };
}

type Env = Record<string, string | undefined>;

/**
 * Parses and validates configuration from a plain record.
 *
 * Pure: takes the environment as an argument rather than reading process.env,
 * so it can be exhaustively tested. Collects every problem before throwing, so
 * an operator fixes one round of errors instead of one error per restart.
 */
export function parseConfig(env: Env): AppConfig {
  const problems: string[] = [];

  const str = (key: string): string => {
    const v = env[key];
    if (v === undefined || v.trim() === "") {
      problems.push(`${key} is required`);
      return "";
    }
    return v.trim();
  };

  const int = (key: string, { min = 1 }: { min?: number } = {}): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") {
      problems.push(`${key} is required`);
      return min;
    }
    if (!/^-?\d+$/.test(raw.trim())) {
      problems.push(`${key} must be a whole number, got "${raw}"`);
      return min;
    }
    const n = Number(raw);
    if (n < min) {
      problems.push(`${key} must be >= ${min}, got ${n}`);
      return min;
    }
    return n;
  };

  /**
   * Money settings are declared in SIGNA.
   *
   * Decimal places are counted on the RAW STRING because Amount.fromSigna
   * silently rounds anything finer than a planck. Delegating the check to the
   * library would let a mistyped reward through, quietly rounded.
   */
  const signa = (key: string): Amount => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") {
      problems.push(`${key} is required`);
      return Amount.Zero();
    }
    const text = raw.trim();
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) {
      problems.push(`${key} must be a positive decimal number of SIGNA, got "${raw}"`);
      return Amount.Zero();
    }
    const decimals = match[2]?.length ?? 0;
    if (decimals > 8) {
      problems.push(
        `${key} has ${decimals} decimal places; SIGNA has at most 8 (1 planck), got "${raw}"`,
      );
      return Amount.Zero();
    }
    const amount = Amount.fromSigna(text);
    try {
      toPlanckInt(amount);
    } catch (e) {
      if (e instanceof MoneyError) {
        problems.push(`${key} is too large to represent exactly, got "${raw}"`);
        return Amount.Zero();
      }
      throw e;
    }
    if (!amount.greater(Amount.Zero())) {
      problems.push(`${key} must be greater than zero`);
    }
    return amount;
  };

  const bool = (key: string): boolean => {
    const raw = (env[key] ?? "").trim().toLowerCase();
    if (raw === "true") return true;
    if (raw === "false" || raw === "") return false;
    problems.push(`${key} must be "true" or "false", got "${raw}"`);
    return false;
  };

  /** A grouped setting is either fully configured or absent. Half-configured is an error. */
  const pair = (
    label: string,
    a: [string, string | undefined],
    b: [string, string | undefined],
  ): [string, string] | undefined => {
    const [aKey, aVal] = a;
    const [bKey, bVal] = b;
    if (!aVal && !bVal) return undefined;
    if (!aVal) problems.push(`${aKey} is required to enable ${label}`);
    if (!bVal) problems.push(`${bKey} is required to enable ${label}`);
    return aVal && bVal ? [aVal, bVal] : undefined;
  };

  const policy: RewardPolicyConfig = {
    rewardPerBlock: signa("REWARD_PER_BLOCK_SIGNA"),
    accountDailyCap: signa("ACCOUNT_DAILY_CAP_SIGNA"),
    globalDailyBudget: signa("GLOBAL_DAILY_BUDGET_SIGNA"),
  };

  const rails: RailsConfig = {
    maxPerRecipientPerBatch: signa("MAX_PER_RECIPIENT_PER_BATCH_SIGNA"),
    maxPerBatch: signa("MAX_PER_BATCH_SIGNA"),
    maxPerWallClockDay: signa("MAX_PER_WALLCLOCK_DAY_SIGNA"),
  };

  // Cross-field sanity. Each is a configuration that would "work" but mean
  // something the operator almost certainly did not intend.
  if (policy.rewardPerBlock.greater(policy.accountDailyCap)) {
    problems.push(
      "REWARD_PER_BLOCK_SIGNA exceeds ACCOUNT_DAILY_CAP_SIGNA: no block could ever be rewarded",
    );
  }
  if (policy.accountDailyCap.greater(policy.globalDailyBudget)) {
    problems.push(
      "ACCOUNT_DAILY_CAP_SIGNA exceeds GLOBAL_DAILY_BUDGET_SIGNA: one account could take the whole budget",
    );
  }

  const mainnetNodeHosts = (env.MAINNET_NODE_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (mainnetNodeHosts.length === 0) {
    problems.push("MAINNET_NODE_HOSTS is required (comma separated)");
  }

  const payoutsEnabled = bool("PAYOUTS_ENABLED");
  const accountSeed = env.PAYOUT_ACCOUNT_SEED?.trim() || undefined;
  if (payoutsEnabled && !accountSeed) {
    problems.push("PAYOUT_ACCOUNT_SEED is required when PAYOUTS_ENABLED=true");
  }

  const notify: AppConfig["notify"] = {};
  const tg = pair(
    "Telegram",
    ["TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN],
    ["TELEGRAM_CHAT_ID", env.TELEGRAM_CHAT_ID],
  );
  if (tg) notify.telegram = { botToken: tg[0], chatId: tg[1] };
  if (env.DISCORD_WEBHOOK_URL) notify.discord = { webhookUrl: env.DISCORD_WEBHOOK_URL };
  const mail = pair(
    "email",
    ["RESEND_API_KEY", env.RESEND_API_KEY],
    ["ALERT_EMAIL_TO", env.ALERT_EMAIL_TO],
  );
  if (mail) notify.email = { resendApiKey: mail[0], to: mail[1] };

  // Publishing is optional: without it the service still indexes, accrues and
  // alerts, so the indexer can be run and verified without a cloud database.
  const turso = pair(
    "Turso publishing",
    ["TURSO_DATABASE_URL", env.TURSO_DATABASE_URL],
    ["TURSO_AUTH_TOKEN", env.TURSO_AUTH_TOKEN],
  );

  const config: AppConfig = {
    dataDir: str("DATA_DIR"),
    policy,
    rails,
    minPayout: signa("MIN_PAYOUT_SIGNA"),
    maxFee: signa("MAX_FEE_SIGNA"),
    minWalletBalance: signa("MIN_WALLET_BALANCE_SIGNA"),
    chain: {
      testnetNodeHost: str("TESTNET_NODE_HOST"),
      testnetWsUrl: str("TESTNET_WS_URL"),
      mainnetNodeHosts,
      startHeight: int("START_HEIGHT", { min: 0 }),
      blockOffset: int("BLOCK_OFFSET", { min: 0 }),
      walkerIntervalSeconds: int("WALKER_INTERVAL_SECONDS"),
    },
    payouts: {
      enabled: payoutsEnabled,
      intervalMinutes: int("PAYOUT_INTERVAL_MINUTES"),
      deadlineMinutes: int("TX_DEADLINE_MINUTES"),
      confirmationsRequired: int("CONFIRMATIONS_REQUIRED"),
      accountSeed,
    },
    health: {
      stallThresholdMinutes: int("STALL_THRESHOLD_MINUTES"),
      minPeers: int("MIN_PEERS", { min: 0 }),
      syncLagBlocks: int("SYNC_LAG_BLOCKS", { min: 0 }),
      alertOpenAfterChecks: int("ALERT_OPEN_AFTER_CHECKS"),
      alertCloseAfterChecks: int("ALERT_CLOSE_AFTER_CHECKS"),
    },
    publish: {
      turso: turso ? { databaseUrl: turso[0], authToken: turso[1] } : undefined,
      intervalSeconds: int("PUBLISH_INTERVAL_SECONDS"),
      stalenessThresholdSeconds: int("STALENESS_THRESHOLD_SECONDS"),
      accountTtlPositiveSeconds: int("MAINNET_ACCOUNT_TTL_POSITIVE_SECONDS"),
      accountTtlNegativeSeconds: int("MAINNET_ACCOUNT_TTL_NEGATIVE_SECONDS"),
    },
    notify,
    admin: {
      bindHost: str("ADMIN_BIND_HOST"),
      port: int("ADMIN_PORT"),
      token: str("ADMIN_TOKEN"),
    },
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
