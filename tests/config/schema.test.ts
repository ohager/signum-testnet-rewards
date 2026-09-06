import { test, expect, describe } from "bun:test";
import { parseConfig, ConfigError } from "../../src/config/schema.ts";

/** A complete, valid environment using the agreed reward parameters. */
const validEnv = (): Record<string, string> => ({
  DATA_DIR: "/mnt/hdd/signum-rewards",
  REWARD_PER_BLOCK_SIGNA: "2.5",
  ACCOUNT_DAILY_CAP_SIGNA: "100",
  GLOBAL_DAILY_BUDGET_SIGNA: "1000",
  MIN_PAYOUT_SIGNA: "5",
  MAX_PER_RECIPIENT_PER_BATCH_SIGNA: "200",
  MAX_PER_BATCH_SIGNA: "2000",
  MAX_PER_WALLCLOCK_DAY_SIGNA: "3000",
  MIN_WALLET_BALANCE_SIGNA: "5000",
  MAX_FEE_SIGNA: "1",
  TESTNET_NODE_HOST: "http://localhost:6876",
  TESTNET_WS_URL: "ws://localhost:6877/events",
  MAINNET_NODE_HOSTS: "https://node-a.example,https://node-b.example",
  START_HEIGHT: "1200000",
  BLOCK_OFFSET: "2",
  WALKER_INTERVAL_SECONDS: "5",
  PAYOUTS_ENABLED: "false",
  PAYOUT_INTERVAL_MINUTES: "360",
  TX_DEADLINE_MINUTES: "30",
  CONFIRMATIONS_REQUIRED: "3",
  STALL_THRESHOLD_MINUTES: "15",
  MIN_PEERS: "3",
  SYNC_LAG_BLOCKS: "5",
  ALERT_OPEN_AFTER_CHECKS: "3",
  ALERT_CLOSE_AFTER_CHECKS: "3",
  TESTNET_REFERENCE_NODE_HOSTS: "https://ref-a.example",
  FORK_CHECK_INTERVAL_SECONDS: "300",
  FORK_CHECK_DEPTH: "10",
  PUBLISH_INTERVAL_SECONDS: "30",
  STALENESS_THRESHOLD_SECONDS: "180",
  PUBLISH_FULL_SYNC_MINUTES: "60",
  RETENTION_DAYS: "30",
  MAINNET_ACCOUNT_TTL_POSITIVE_SECONDS: "86400",
  MAINNET_ACCOUNT_TTL_NEGATIVE_SECONDS: "3600",
  ADMIN_BIND_HOST: "192.168.1.50",
  ADMIN_PORT: "3100",
  ADMIN_TOKEN: "secret",
});

describe("parseConfig", () => {
  test("parses a complete valid environment into Amounts", () => {
    const cfg = parseConfig(validEnv());
    expect(cfg.policy.rewardPerBlock.getSigna()).toBe("2.5");
    expect(cfg.policy.rewardPerBlock.getPlanck()).toBe("250000000");
    expect(cfg.policy.globalDailyBudget.getSigna()).toBe("1000");
    expect(cfg.chain.mainnetNodeHosts).toEqual(["https://node-a.example", "https://node-b.example"]);
    expect(cfg.payouts.enabled).toBe(false);
    expect(cfg.admin.port).toBe(3100);
  });

  test("reports every missing required key at once, not just the first", () => {
    const env = validEnv();
    delete env.REWARD_PER_BLOCK_SIGNA;
    delete env.GLOBAL_DAILY_BUDGET_SIGNA;
    try {
      parseConfig(env);
      throw new Error("expected parseConfig to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain("REWARD_PER_BLOCK_SIGNA");
      expect(msg).toContain("GLOBAL_DAILY_BUDGET_SIGNA");
    }
  });

  test("accepts decimal SIGNA values down to one planck", () => {
    const env = validEnv();
    env.REWARD_PER_BLOCK_SIGNA = "0.12345678";
    expect(parseConfig(env).policy.rewardPerBlock.getPlanck()).toBe("12345678");
  });

  test("rejects a SIGNA value with sub-planck precision", () => {
    // Amount.fromSigna SILENTLY ROUNDS 9 decimals to 8, so validation must count
    // decimal places on the raw string. Relying on Amount to complain would let a
    // mistyped reward through, quietly rounded.
    const env = validEnv();
    env.REWARD_PER_BLOCK_SIGNA = "0.123456789";
    expect(() => parseConfig(env)).toThrow(/decimal/i);
  });

  test("rejects a non-numeric SIGNA value", () => {
    const env = validEnv();
    env.REWARD_PER_BLOCK_SIGNA = "two point five";
    expect(() => parseConfig(env)).toThrow(ConfigError);
  });

  test("rejects a zero reward", () => {
    const env = validEnv();
    env.REWARD_PER_BLOCK_SIGNA = "0";
    expect(() => parseConfig(env)).toThrow(ConfigError);
  });

  test("rejects a per-block reward larger than the per-account daily cap", () => {
    const env = validEnv();
    env.REWARD_PER_BLOCK_SIGNA = "150";
    expect(() => parseConfig(env)).toThrow(/ACCOUNT_DAILY_CAP_SIGNA/);
  });

  test("rejects an account daily cap larger than the global daily budget", () => {
    const env = validEnv();
    env.ACCOUNT_DAILY_CAP_SIGNA = "2000";
    expect(() => parseConfig(env)).toThrow(/GLOBAL_DAILY_BUDGET_SIGNA/);
  });

  test("requires a seed when payouts are enabled", () => {
    const env = validEnv();
    env.PAYOUTS_ENABLED = "true";
    expect(() => parseConfig(env)).toThrow(/PAYOUT_ACCOUNT_SEED/);
  });

  test("accepts payouts enabled when a seed is present", () => {
    const env = validEnv();
    env.PAYOUTS_ENABLED = "true";
    env.PAYOUT_ACCOUNT_SEED = "some twelve word passphrase goes right here ok";
    expect(parseConfig(env).payouts.enabled).toBe(true);
  });

  test("rejects an empty mainnet node list", () => {
    const env = validEnv();
    env.MAINNET_NODE_HOSTS = "";
    expect(() => parseConfig(env)).toThrow(ConfigError);
  });

  test("PUBLISHING IS OPTIONAL: absent Turso config disables it rather than failing", () => {
    // The indexer must be runnable without a cloud database.
    expect(parseConfig(validEnv()).publish.turso).toBeUndefined();
  });

  test("half-configured Turso is an error, not a silent disable", () => {
    const env = validEnv();
    env.TURSO_DATABASE_URL = "libsql://example.turso.io";
    expect(() => parseConfig(env)).toThrow(/TURSO_AUTH_TOKEN/);
  });

  test("fully configured Turso enables publishing", () => {
    const env = validEnv();
    env.TURSO_DATABASE_URL = "libsql://example.turso.io";
    env.TURSO_AUTH_TOKEN = "token";
    expect(parseConfig(env).publish.turso).toEqual({
      databaseUrl: "libsql://example.turso.io",
      authToken: "token",
    });
  });

  test("leaves notification channels undefined when unconfigured", () => {
    const cfg = parseConfig(validEnv());
    expect(cfg.notify.telegram).toBeUndefined();
    expect(cfg.notify.discord).toBeUndefined();
    expect(cfg.notify.email).toBeUndefined();
  });

  test("enables a channel only when all of its keys are present", () => {
    const env = validEnv();
    env.TELEGRAM_BOT_TOKEN = "bot123";
    expect(() => parseConfig(env)).toThrow(/TELEGRAM_CHAT_ID/);
    env.TELEGRAM_CHAT_ID = "42";
    expect(parseConfig(env).notify.telegram).toEqual({ botToken: "bot123", chatId: "42" });
  });

  test("email needs a sender: Resend rejects anything outside a verified domain", () => {
    const env = validEnv();
    env.RESEND_API_KEY = "re_key";
    env.ALERT_EMAIL_TO = "ops@example.dev";

    expect(() => parseConfig(env)).toThrow(/ALERT_EMAIL_FROM/);
  });

  test("a fully configured email channel defaults to critical only", () => {
    const env = validEnv();
    env.RESEND_API_KEY = "re_key";
    env.ALERT_EMAIL_TO = "ops@example.dev";
    env.ALERT_EMAIL_FROM = "Rewards <alerts@example.dev>";

    expect(parseConfig(env).notify.email).toEqual({
      resendApiKey: "re_key",
      to: "ops@example.dev",
      from: "Rewards <alerts@example.dev>",
      minSeverity: "critical",
    });
  });

  test("the email severity can be widened to every alert", () => {
    const env = validEnv();
    env.RESEND_API_KEY = "re_key";
    env.ALERT_EMAIL_TO = "ops@example.dev";
    env.ALERT_EMAIL_FROM = "Rewards <alerts@example.dev>";
    env.ALERT_EMAIL_MIN_SEVERITY = "WARNING";

    expect(parseConfig(env).notify.email?.minSeverity).toBe("warning");
  });

  test("A TYPO IN THE SEVERITY IS REJECTED, never silently narrowed", () => {
    const env = validEnv();
    env.RESEND_API_KEY = "re_key";
    env.ALERT_EMAIL_TO = "ops@example.dev";
    env.ALERT_EMAIL_FROM = "Rewards <alerts@example.dev>";
    env.ALERT_EMAIL_MIN_SEVERITY = "urgent";

    expect(() => parseConfig(env)).toThrow(/ALERT_EMAIL_MIN_SEVERITY/);
  });

  test("email stays off when only the sender is set", () => {
    const env = validEnv();
    env.ALERT_EMAIL_FROM = "Rewards <alerts@example.dev>";

    expect(parseConfig(env).notify.email).toBeUndefined();
  });
});
