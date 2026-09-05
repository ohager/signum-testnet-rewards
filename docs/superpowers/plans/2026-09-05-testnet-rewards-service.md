# Testnet Rewards Service — Implementation Plan (Phase 1: Shadow Mode)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Pi-side service to the point where it runs unattended against live testnet, accrues rewards correctly, monitors health, alerts, publishes a read-model to Turso, and can dry-run payout batches — all with `PAYOUTS_ENABLED=false`.

**Architecture:** Single Bun process under pm2. `signum-chain-walker` walks/listens testnet blocks; each block is scored by pure policy functions and recorded in a local `bun:sqlite` ledger keyed by block id, so replays are harmless. A SIP-50 WebSocket plus HTTP fallback drives a health state machine. A publisher pushes a disposable read-model to Turso. A LAN-only admin UI exposes state and a batch dry-run.

**Tech Stack:** Bun 1.3.13, TypeScript (strict), `bun:sqlite`, `signum-chain-walker`, `@signumjs/core`, `@signumjs/util`, `@libsql/client`, pm2.

**Scope boundary:** This plan deliberately stops before broadcasting real transactions. Batch composition and dry-run are built here; `payout/broadcast.ts` and `payout/reconcile.ts` are Phase 2. This matches Rollout Stage 1 in the spec.

**Spec:** `docs/superpowers/specs/2026-09-05-signum-testnet-rewards-design.md`

---

## Toolchain gotchas (read before Task 1)

These are properties of *this* repo's `tsconfig.json` and dependencies. Violating them produces confusing errors:

1. **`verbatimModuleSyntax: true`** — type-only imports MUST use `import type`. `import { Block } from "@signumjs/core"` fails at runtime if `Block` is only a type. Write `import type { Block } from "@signumjs/core"`.
2. **`noUncheckedIndexedAccess: true`** — `arr[0]` has type `T | undefined`. Every indexed access needs a guard or a non-null assertion you can justify.
3. **`MockLedger` is not re-exported** from `signum-chain-walker`'s entry point (`index.ts` only does `export * from "./chainWalker"`). Import it directly: `import type { MockLedger } from "signum-chain-walker/dist/mockLedger"`.
4. **Signum timestamps are chain-epoch seconds**, not Unix. Convert with `ChainTime.fromChainTimestamp(ts).getDate()` from `@signumjs/util`.
5. **Amounts use `Amount` from `@signumjs/util`**, never raw numbers, everywhere except inside SQLite columns. See the next point.
6. **`Amount` arithmetic MUTATES.** `a.add(b)` modifies `a` and returns `a` itself, so `list.reduce((x, y) => x.add(y))` silently corrupts `list[0]`. Always `clone()` before accumulating, or use `sumAmounts()` from `src/domain/money.ts`. This is the single easiest way to introduce a money bug in this codebase. Use `Amount.fromSigna()` from  `@signumjs/util`.

## Verified API facts

Confirmed by reading the installed packages and `signum-node` source — do not re-derive these:

- `Block` fields used here: `block` (id, string), `height`, `timestamp`, `generator`, `generatorRS`, `generatorPublicKey`.
- `Account.publicKey: string`, `Account.balanceNQT: string`.
- `BlockchainStatus`: `numberOfBlocks` (local height), `lastBlockchainFeederHeight` (network height), `isScanning`, `lastBlock`.
- `signum-node/src/brs/Constants.java`: `MAX_MULTI_OUT_RECIPIENTS = 64`.
- `signum-node/src/brs/Attachment.java`: rejects `recipients.size() <= 1` — single-recipient batches cannot use multi-out.
- SIP-50 WebSocket: `ws://<host>:<httpPort + 1>/events`; events `CONNECTED`, `HEARTBEAT` (~30s), `BLOCK_PUSHED`, `PENDING_TRANSACTIONS_ADDED`; envelope is `{ e: "EVENT_NAME", p: {...} }`.
- `Amount` (verified by running it): `add`/`subtract`/`multiply`/`divide` mutate the receiver and return `this`; `clone()` is the only safe way to accumulate. `getPlanck()` returns a string, `getSigna()` returns a string, `fromPlanck()` accepts number or string, `fromSigna()` accepts a decimal string. `fromSigna` SILENTLY ROUNDS input finer than a planck (`0.123456789` -> 12345679 planck) and `fromPlanck('1.5')` -> 2, so getPlanck() is always an integer string. `toString()` renders like `Ꞩ 1,234.5`.

---

## File structure

```
src/
  main.ts                    composition root, startup order, graceful shutdown
  config/
    schema.ts                AppConfig type + pure parse/validate from a record
    load.ts                  reads process.env, checks volume sentinel, throws on invalid
  domain/
    money.ts                 Amount re-export, planck-int conversion, mutation-safe sum
    chainDay.ts              chain timestamp -> 'YYYY-MM-DD' (pure)
    policy.ts                reward + cap arithmetic (pure)
    rails.ts                 safety rail checks (pure)
    types.ts                 shared domain types
  ledger/
    schema.sql               DDL, applied at startup
    db.ts                    open, pragmas, migrate
    blockRewards.ts          accrual insert + daily sums + queries
    batches.ts               batch create/claim/transition
    alerts.ts                open/resolve incidents
    state.ts                 service_state key/value
    healthSamples.ts         insert + prune + downsample
  chain/
    testnetClient.ts         testnet reads (status, peers)
    mainnetPool.ts           failover pool over public mainnet nodes
  eligibility/
    accountCache.ts          mainnet_accounts TTL cache
    eligibility.ts           payability decision
  indexer/
    indexer.ts               chain-walker wiring: block -> eligibility -> accrual
  payout/
    compose.ts               build a BatchDraft from unpaid accruals (pure given input)
    dryRun.ts                compose + rails + render, never broadcasts
  health/
    healthState.ts           tier state machine (pure)
    wsMonitor.ts             SIP-50 client with reconnect
    httpProbe.ts             REST fallback probes
    monitor.ts               orchestration: feeds state machine, raises alerts
  notify/
    channel.ts               Channel interface + Severity
    telegram.ts  discord.ts  email.ts
    notifier.ts              fan-out, severity routing, retry-on-reconnect
  publish/
    projection.ts            builds the read-model (shared by publisher + admin)
    tursoPublisher.ts        upsert + watermark push to Turso
  admin/
    server.ts                Bun.serve routes + token auth
    index.html  app.tsx      utilitarian UI
tests/                       mirrors src/ layout
config/
  .env.example
  ecosystem.config.cjs
  turso-schema.sql
scripts/
  setup-volume.ts            writes the .volume-ok sentinel
```

Rationale for the splits: `domain/` holds every pure function so the money arithmetic can be tested exhaustively without a database. `ledger/` is split per table-group rather than one repository file, so each stays small and the functions that change together live together. `projection.ts` is deliberately separate from `tursoPublisher.ts` because the admin UI consumes the same projection.

---

## Task 1: Project scaffolding, domain types and the money module

Amounts are represented by `Amount` from `@signumjs/util` everywhere except inside SQLite columns. This is the single most important convention in the codebase: it removes planck-vs-SIGNA ambiguity from every signature.

**Files:**
- Modify: `package.json`
- Create: `src/domain/types.ts`
- Create: `src/domain/money.ts`
- Test: `tests/domain/money.test.ts`

- [ ] **Step 1: Install dependencies**

```bash
bun add @signumjs/core @signumjs/util @libsql/client
```

- [ ] **Step 2: Add scripts to `package.json`**

Merge this `scripts` block into `package.json`, keeping the existing `dependencies`:

```json
  "scripts": {
    "start": "bun run src/main.ts",
    "dev": "bun --hot src/main.ts",
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit"
  },
```

- [ ] **Step 3: Write the failing test**

Create `tests/domain/money.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { Amount } from "@signumjs/util";
import {
  toPlanckInt,
  fromPlanckInt,
  sumAmounts,
  zero,
  MoneyError,
} from "../../src/domain/money.ts";

describe("planck integer conversion", () => {
  test("round-trips a whole-planck amount", () => {
    const amount = Amount.fromSigna("2.5");
    expect(toPlanckInt(amount)).toBe(250_000_000);
    expect(fromPlanckInt(250_000_000).getSigna()).toBe("2.5");
  });

  test("zero round-trips", () => {
    expect(toPlanckInt(Amount.Zero())).toBe(0);
    expect(fromPlanckInt(0).getPlanck()).toBe("0");
  });

  test("rejects a fractional planck value, which cannot be stored", () => {
    // Amount is BigNumber-backed and can hold sub-planck precision; SQLite cannot.
    const fractional = Amount.fromPlanck("1").divide(3);
    expect(() => toPlanckInt(fractional)).toThrow(MoneyError);
  });

  test("rejects a value beyond JS safe-integer range", () => {
    const huge = Amount.fromPlanck("9007199254740993");
    expect(() => toPlanckInt(huge)).toThrow(MoneyError);
  });
});

describe("sumAmounts", () => {
  test("adds a list of amounts", () => {
    const total = sumAmounts([Amount.fromSigna("1"), Amount.fromSigna("2.5")]);
    expect(total.getSigna()).toBe("3.5");
  });

  test("MUTATION SAFETY: does not modify its inputs", () => {
    // Amount.add() mutates the receiver and returns `this`. A naive reduce would
    // corrupt the first element of the list. This is the bug this helper exists to prevent.
    const a = Amount.fromSigna("1");
    const b = Amount.fromSigna("2");
    sumAmounts([a, b]);
    expect(a.getSigna()).toBe("1");
    expect(b.getSigna()).toBe("2");
  });

  test("summing twice yields the same result", () => {
    const list = [Amount.fromSigna("1"), Amount.fromSigna("2")];
    expect(sumAmounts(list).getSigna()).toBe(sumAmounts(list).getSigna());
  });

  test("an empty list sums to zero", () => {
    expect(sumAmounts([]).getPlanck()).toBe("0");
  });

  test("zero() returns a fresh object each time, never a shared one", () => {
    const a = zero();
    const b = zero();
    a.add(Amount.fromSigna("5"));
    expect(b.getSigna()).toBe("0");
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun test tests/domain/money.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/money.ts'`

- [ ] **Step 5: Create the domain types**

Create `src/domain/types.ts`:

```ts
import type { Amount } from "@signumjs/util";

/**
 * Whole planck, used ONLY as the SQLite storage representation.
 * Business logic uses Amount; see src/domain/money.ts.
 */
export type PlanckInt = number;

/** UTC calendar day derived from a block's chain timestamp, 'YYYY-MM-DD'. */
export type ChainDay = string;

export type BlockRewardStatus =
  | "accrued"
  | "skipped_no_mainnet_account"
  | "skipped_pubkey_mismatch"
  | "skipped_excluded"
  | "skipped_account_cap"
  | "skipped_global_cap";

export interface RecipientAmount {
  recipientId: string;
  amount: Amount;
}

export interface BatchDraft {
  recipients: RecipientAmount[];
  total: Amount;
}
```

- [ ] **Step 6: Create the money module**

Create `src/domain/money.ts`:

```ts
import { Amount, AmountFormats } from "@signumjs/util";
import type { PlanckInt } from "./types.ts";

export { Amount };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Converts an Amount to the whole-planck integer stored in SQLite.
 *
 * Amount is BigNumber-backed and can represent sub-planck precision that the
 * database cannot. Rather than rounding silently — which would leak or invent
 * fractions of a planck on the money path — anything that is not a whole,
 * safely-representable integer is rejected.
 */
export function toPlanckInt(amount: Amount): PlanckInt {
  const raw = amount.getPlanck();
  if (!/^-?\d+$/.test(raw)) {
    throw new MoneyError(`Amount is not a whole number of planck: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new MoneyError(`Planck value ${raw} is outside the JS safe-integer range`);
  }
  return n;
}

export function fromPlanckInt(planck: PlanckInt): Amount {
  return Amount.fromPlanck(planck);
}

/** A fresh zero. Never share one: Amount arithmetic mutates in place. */
export function zero(): Amount {
  return Amount.Zero();
}

/**
 * Sums amounts without mutating any input.
 *
 * IMPORTANT: Amount.add() mutates the receiver and returns `this`, so
 * `list.reduce((a, b) => a.add(b))` silently corrupts `list[0]`. Always sum
 * through this helper.
 */
export function sumAmounts(amounts: Amount[]): Amount {
  const total = Amount.Zero();
  for (const a of amounts) total.add(a);
  return total;
}

/** Human-readable, for logs, the admin UI and the status page. */
export function formatSigna(amount: Amount): string {
  return amount.toString(AmountFormats.DotDecimal);
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/domain/money.test.ts`
Expected: `9 pass, 0 fail`

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock src/domain tests/domain
git commit -m "chore: scaffold deps and add Amount-based money module"
```

---

## Task 2: Chain day conversion

Chain-day bucketing is what keeps caps stable across replays. It gets its own module because every cap query depends on it.

**Files:**
- Create: `src/domain/chainDay.ts`
- Test: `tests/domain/chainDay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/chainDay.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { ChainTime } from "@signumjs/util";
import { toChainDay } from "../../src/domain/chainDay.ts";

describe("toChainDay", () => {
  test("converts a chain timestamp to its UTC calendar day", () => {
    // Build a chain timestamp from a known UTC date, then convert back.
    const ts = ChainTime.fromDate(new Date("2026-03-14T12:00:00Z")).getChainTimestamp();
    expect(toChainDay(ts)).toBe("2026-03-14");
  });

  test("uses UTC, not local time, at day boundaries", () => {
    const justBefore = ChainTime.fromDate(new Date("2026-03-14T23:59:59Z")).getChainTimestamp();
    const justAfter = ChainTime.fromDate(new Date("2026-03-15T00:00:01Z")).getChainTimestamp();
    expect(toChainDay(justBefore)).toBe("2026-03-14");
    expect(toChainDay(justAfter)).toBe("2026-03-15");
  });

  test("is stable: same input always yields same output", () => {
    const ts = ChainTime.fromDate(new Date("2026-01-01T00:00:00Z")).getChainTimestamp();
    expect(toChainDay(ts)).toBe(toChainDay(ts));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/domain/chainDay.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/chainDay.ts'`

- [ ] **Step 3: Implement**

Create `src/domain/chainDay.ts`:

```ts
import { ChainTime } from "@signumjs/util";
import type { ChainDay } from "./types.ts";

/**
 * Maps a Signum chain timestamp (seconds since genesis) to its UTC calendar day.
 *
 * Cap accounting buckets on this rather than wall-clock time so that a catch-up
 * after an outage attributes blocks to the day they were actually mined.
 */
export function toChainDay(chainTimestamp: number): ChainDay {
  const date = ChainTime.fromChainTimestamp(chainTimestamp).getDate();
  return date.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/domain/chainDay.test.ts`
Expected: `3 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/domain/chainDay.ts tests/domain/chainDay.test.ts
git commit -m "feat: add chain timestamp to UTC chain-day conversion"
```

---

## Task 3: Reward policy (pure)

This is where money bugs live, so it is pure and tested exhaustively.

**Agreed parameters:** 2.5 SIGNA per block, 100 SIGNA per account per day, 1000 SIGNA global per day. At Signum's ~360 blocks/day this is ~900 SIGNA/day at full block production, so the global budget acts as a backstop rather than a mid-day cliff.

**Design decision baked in here:** if the full reward does not fit under a cap, the block is **skipped entirely** rather than clamped to the remainder. Clamping would emit unpredictable dust and make the advertised per-block rate untrue. Skipping is deterministic and explainable on the status page.

**Files:**
- Create: `src/domain/policy.ts`
- Test: `tests/domain/policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/policy.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { Amount } from "@signumjs/util";
import { decideReward } from "../../src/domain/policy.ts";
import type { RewardPolicyConfig, RewardContext } from "../../src/domain/policy.ts";

const cfg: RewardPolicyConfig = {
  rewardPerBlock: Amount.fromSigna("2.5"),
  accountDailyCap: Amount.fromSigna("100"),
  globalDailyBudget: Amount.fromSigna("1000"),
};

const ctx = (accountSigna: string, globalSigna: string): RewardContext => ({
  accountAccruedToday: Amount.fromSigna(accountSigna),
  globalAccruedToday: Amount.fromSigna(globalSigna),
});

describe("decideReward", () => {
  test("accrues the full reward when well under both caps", () => {
    const decision = decideReward(cfg, ctx("0", "0"));
    expect(decision.kind).toBe("accrue");
    if (decision.kind === "accrue") expect(decision.amount.getSigna()).toBe("2.5");
  });

  test("accrues when the reward exactly fills the account cap", () => {
    const decision = decideReward(cfg, ctx("97.5", "0"));
    expect(decision.kind).toBe("accrue");
  });

  test("skips when the reward would exceed the account cap", () => {
    expect(decideReward(cfg, ctx("98", "0"))).toEqual({
      kind: "skip",
      status: "skipped_account_cap",
    });
  });

  test("skips when the reward would exceed the global budget", () => {
    expect(decideReward(cfg, ctx("0", "998"))).toEqual({
      kind: "skip",
      status: "skipped_global_cap",
    });
  });

  test("accrues when the reward exactly fills the global budget", () => {
    expect(decideReward(cfg, ctx("0", "997.5")).kind).toBe("accrue");
  });

  test("account cap takes precedence when both would be exceeded", () => {
    expect(decideReward(cfg, ctx("100", "1000"))).toEqual({
      kind: "skip",
      status: "skipped_account_cap",
    });
  });

  test("MUTATION SAFETY: deciding does not modify the config amounts", () => {
    decideReward(cfg, ctx("50", "500"));
    decideReward(cfg, ctx("50", "500"));
    expect(cfg.rewardPerBlock.getSigna()).toBe("2.5");
    expect(cfg.accountDailyCap.getSigna()).toBe("100");
    expect(cfg.globalDailyBudget.getSigna()).toBe("1000");
  });

  test("MUTATION SAFETY: deciding does not modify the context amounts", () => {
    const context = ctx("50", "500");
    decideReward(cfg, context);
    expect(context.accountAccruedToday.getSigna()).toBe("50");
    expect(context.globalAccruedToday.getSigna()).toBe("500");
  });

  test("never returns a partial amount", () => {
    const decision = decideReward(cfg, ctx("99", "0"));
    if (decision.kind === "accrue") {
      expect(decision.amount.getSigna()).toBe(cfg.rewardPerBlock.getSigna());
    } else {
      expect(decision.status).toBe("skipped_account_cap");
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/domain/policy.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/policy.ts'`

- [ ] **Step 3: Implement**

Create `src/domain/policy.ts`:

```ts
import type { Amount } from "@signumjs/util";
import type { BlockRewardStatus } from "./types.ts";

export interface RewardPolicyConfig {
  rewardPerBlock: Amount;
  accountDailyCap: Amount;
  globalDailyBudget: Amount;
}

export interface RewardContext {
  /** Already accrued to this account on this chain day. */
  accountAccruedToday: Amount;
  /** Already accrued across all accounts on this chain day. */
  globalAccruedToday: Amount;
}

export type RewardDecision =
  | { kind: "accrue"; amount: Amount }
  | {
      kind: "skip";
      status: Extract<BlockRewardStatus, "skipped_account_cap" | "skipped_global_cap">;
    };

/**
 * Decides what a single mined block earns.
 *
 * Rewards are all-or-nothing: if the full per-block reward does not fit under a
 * cap, the block is skipped rather than clamped. Clamping would produce dust of
 * unpredictable size and make the advertised per-block rate a lie.
 *
 * Every arithmetic step clones first, because Amount.add() mutates its receiver.
 */
export function decideReward(cfg: RewardPolicyConfig, ctx: RewardContext): RewardDecision {
  const projectedAccount = ctx.accountAccruedToday.clone().add(cfg.rewardPerBlock);
  if (projectedAccount.greater(cfg.accountDailyCap)) {
    return { kind: "skip", status: "skipped_account_cap" };
  }

  const projectedGlobal = ctx.globalAccruedToday.clone().add(cfg.rewardPerBlock);
  if (projectedGlobal.greater(cfg.globalDailyBudget)) {
    return { kind: "skip", status: "skipped_global_cap" };
  }

  return { kind: "accrue", amount: cfg.rewardPerBlock.clone() };
}
```

Returning a **clone** of `rewardPerBlock` matters: handing out the config's own object would let any caller that does arithmetic on the decision silently mutate the policy for every subsequent block.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/domain/policy.test.ts`
Expected: `9 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/domain/policy.ts tests/domain/policy.test.ts
git commit -m "feat: add pure reward policy with per-account and global daily caps"
```

---

## Task 4: Safety rails (pure)

Rails are the brake against a *bug*, not an attacker. They are checked at compose time and can only ever prevent a send, never shrink one.

**Files:**
- Create: `src/domain/rails.ts`
- Test: `tests/domain/rails.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/rails.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { Amount } from "@signumjs/util";
import { checkRails } from "../../src/domain/rails.ts";
import type { RailsConfig } from "../../src/domain/rails.ts";
import type { BatchDraft } from "../../src/domain/types.ts";
import { sumAmounts } from "../../src/domain/money.ts";

const rails: RailsConfig = {
  maxPerRecipientPerBatch: Amount.fromSigna("200"),
  maxPerBatch: Amount.fromSigna("2000"),
  maxPerWallClockDay: Amount.fromSigna("3000"),
};

const draft = (signaAmounts: string[]): BatchDraft => {
  const recipients = signaAmounts.map((s, i) => ({
    recipientId: `acct-${i}`,
    amount: Amount.fromSigna(s),
  }));
  return { recipients, total: sumAmounts(recipients.map((r) => r.amount)) };
};

const noSpendYet = Amount.Zero();

describe("checkRails", () => {
  test("passes a normal batch", () => {
    expect(checkRails(draft(["10", "20"]), rails, noSpendYet)).toEqual({ ok: true });
  });

  test("passes a batch sitting exactly on every limit", () => {
    expect(checkRails(draft(["200"]), rails, Amount.fromSigna("2800"))).toEqual({ ok: true });
  });

  test("rejects when one recipient exceeds the per-recipient rail", () => {
    const result = checkRails(draft(["200.00000001"]), rails, noSpendYet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("per_recipient");
  });

  test("rejects when the batch total exceeds the per-batch rail", () => {
    const result = checkRails(draft(Array(11).fill("200")), rails, noSpendYet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("per_batch");
  });

  test("rejects when today's wall-clock spend would be exceeded", () => {
    const result = checkRails(draft(["200"]), rails, Amount.fromSigna("2900"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("per_wallclock_day");
  });

  test("rejects a zero or negative amount, which can only come from a bug", () => {
    const result = checkRails(draft(["0"]), rails, noSpendYet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("non_positive_amount");
  });

  test("rejects a draft whose total disagrees with its recipients", () => {
    const bad: BatchDraft = {
      recipients: [{ recipientId: "a", amount: Amount.fromSigna("1") }],
      total: Amount.fromSigna("999"),
    };
    const result = checkRails(bad, rails, noSpendYet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violation).toBe("total_mismatch");
  });

  test("MUTATION SAFETY: checking does not modify the draft or the rails", () => {
    const d = draft(["10", "20"]);
    checkRails(d, rails, noSpendYet);
    checkRails(d, rails, noSpendYet);
    expect(d.total.getSigna()).toBe("30");
    expect(rails.maxPerBatch.getSigna()).toBe("2000");
    expect(noSpendYet.getSigna()).toBe("0");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/domain/rails.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/rails.ts'`

- [ ] **Step 3: Implement**

Create `src/domain/rails.ts`:

```ts
import { Amount } from "@signumjs/util";
import type { BatchDraft } from "./types.ts";

export interface RailsConfig {
  maxPerRecipientPerBatch: Amount;
  maxPerBatch: Amount;
  /** Wall-clock, deliberately: this bounds how fast the wallet can drain. */
  maxPerWallClockDay: Amount;
}

export type RailViolation =
  | "non_positive_amount"
  | "total_mismatch"
  | "per_recipient"
  | "per_batch"
  | "per_wallclock_day";

export type RailsVerdict =
  | { ok: true }
  | { ok: false; violation: RailViolation; detail: string };

/**
 * Hard ceilings evaluated before a batch is persisted or sent.
 *
 * These guard against bugs rather than attackers: a runaway loop, a bad
 * aggregation, or a policy misconfiguration. Any violation must trip the
 * kill-switch rather than silently shrink the batch.
 */
export function checkRails(
  draft: BatchDraft,
  cfg: RailsConfig,
  spentWallClockToday: Amount,
): RailsVerdict {
  const runningTotal = Amount.Zero();

  for (const r of draft.recipients) {
    if (!r.amount.greater(Amount.Zero())) {
      return {
        ok: false,
        violation: "non_positive_amount",
        detail: `${r.recipientId} has amount ${r.amount.getSigna()}`,
      };
    }
    if (r.amount.greater(cfg.maxPerRecipientPerBatch)) {
      return {
        ok: false,
        violation: "per_recipient",
        detail: `${r.recipientId}: ${r.amount.getSigna()} > ${cfg.maxPerRecipientPerBatch.getSigna()}`,
      };
    }
    runningTotal.add(r.amount);
  }

  if (!runningTotal.equals(draft.total)) {
    return {
      ok: false,
      violation: "total_mismatch",
      detail: `recipients sum to ${runningTotal.getSigna()} but total says ${draft.total.getSigna()}`,
    };
  }
  if (draft.total.greater(cfg.maxPerBatch)) {
    return {
      ok: false,
      violation: "per_batch",
      detail: `${draft.total.getSigna()} > ${cfg.maxPerBatch.getSigna()}`,
    };
  }

  const projectedDay = spentWallClockToday.clone().add(draft.total);
  if (projectedDay.greater(cfg.maxPerWallClockDay)) {
    return {
      ok: false,
      violation: "per_wallclock_day",
      detail: `${spentWallClockToday.getSigna()} + ${draft.total.getSigna()} > ${cfg.maxPerWallClockDay.getSigna()}`,
    };
  }

  return { ok: true };
}
```

`runningTotal` starts as a fresh `Amount.Zero()` rather than cloning a caller's value, and `projectedDay` clones before adding — both because `Amount.add()` mutates in place.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/domain/rails.test.ts`
Expected: `8 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/domain/rails.ts tests/domain/rails.test.ts
git commit -m "feat: add pure safety rail checks for payout batches"
```

---

## Task 5: Config schema and validation (pure)

Money settings have **no defaults**. A service that silently falls back to a default payout amount is worse than one that refuses to boot.

**Deviation from the spec, deliberate:** money settings are declared in **SIGNA, not planck** (`REWARD_PER_BLOCK_SIGNA=2.5` rather than `REWARD_PER_BLOCK_PLANCK=250000000`). `Amount.fromSigna` parses decimals exactly, and an operator mistyping a planck value by a factor of 10 is a far likelier failure than anything this costs. Update the spec's `.env.example` block to match in Task 21.

**Files:**
- Create: `src/config/schema.ts`
- Test: `tests/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/config/schema.test.ts`:

```ts
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
  TURSO_DATABASE_URL: "libsql://example.turso.io",
  TURSO_AUTH_TOKEN: "token",
  PUBLISH_INTERVAL_SECONDS: "30",
  STALENESS_THRESHOLD_SECONDS: "180",
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

  test("accepts decimal SIGNA values", () => {
    const env = validEnv();
    env.REWARD_PER_BLOCK_SIGNA = "0.12345678";
    expect(parseConfig(env).policy.rewardPerBlock.getPlanck()).toBe("12345678");
  });

  test("rejects a SIGNA value with sub-planck precision", () => {
    // Amount.fromSigna SILENTLY ROUNDS 9 decimals to 8 (verified in Task 1), so
    // validation must count decimal places on the raw string. Relying on Amount
    // to complain would let a mistyped reward through, rounded.
    const env = validEnv();
    env.REWARD_PER_BLOCK_SIGNA = "0.123456789"; // 9 decimals
    expect(() => parseConfig(env)).toThrow(/decimal/i);
  });

  test("rejects a non-numeric SIGNA value", () => {
    const env = validEnv();
    env.REWARD_PER_BLOCK_SIGNA = "two point five";
    expect(() => parseConfig(env)).toThrow(ConfigError);
  });

  test("rejects a zero or negative reward", () => {
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/config/schema.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/schema.ts'`

- [ ] **Step 3: Implement**

Create `src/config/schema.ts`:

```ts
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
    tursoDatabaseUrl: string;
    tursoAuthToken: string;
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
   * Money settings are declared in SIGNA. Values are rejected unless they land
   * on a whole planck, so a typo cannot silently create an unrepresentable amount.
   */
  const signa = (key: string, { allowZero = false }: { allowZero?: boolean } = {}): Amount => {
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
    // Amount.fromSigna silently rounds anything finer than a planck, so the
    // decimal count is checked here rather than left to the library.
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
    if (!allowZero && !amount.greater(Amount.Zero())) {
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

  /** A channel is either fully configured or absent. Half-configured is an error. */
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

  const tg = pair(
    "Telegram",
    ["TELEGRAM_BOT_TOKEN", env.TELEGRAM_BOT_TOKEN],
    ["TELEGRAM_CHAT_ID", env.TELEGRAM_CHAT_ID],
  );
  if (tg) notify.telegram = { botToken: tg[0], chatId: tg[1] };

  if (env.DISCORD_WEBHOOK_URL) {
    notify.discord = { webhookUrl: env.DISCORD_WEBHOOK_URL };
  }

  const mail = pair(
    "email",
    ["RESEND_API_KEY", env.RESEND_API_KEY],
    ["ALERT_EMAIL_TO", env.ALERT_EMAIL_TO],
  );
  if (mail) notify.email = { resendApiKey: mail[0], to: mail[1] };

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
      tursoDatabaseUrl: str("TURSO_DATABASE_URL"),
      tursoAuthToken: str("TURSO_AUTH_TOKEN"),
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/config/schema.test.ts`
Expected: `13 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts tests/config/schema.test.ts
git commit -m "feat: add config schema parsing SIGNA amounts with fail-fast validation"
```

---

## Task 6: Config loading and the volume sentinel

**This task prevents the worst failure mode in the design.** If the HDD is not mounted when the service starts, SQLite silently creates an empty database, the walker cache is absent, and the entire block history is re-accrued into an empty ledger. The idempotency guards from Task 8 cannot help — they protect against duplicate rows, not against a missing table to check against.

**Files:**
- Create: `src/config/load.ts`
- Create: `scripts/setup-volume.ts`
- Test: `tests/config/load.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/config/load.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDataVolumeMounted,
  VolumeNotMountedError,
  SENTINEL_FILENAME,
} from "../../src/config/load.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewards-vol-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("assertDataVolumeMounted", () => {
  test("passes when the sentinel file is present", () => {
    writeFileSync(join(dir, SENTINEL_FILENAME), "ok");
    expect(() => assertDataVolumeMounted(dir)).not.toThrow();
  });

  test("throws when the directory exists but the sentinel is missing", () => {
    // Exactly the unmounted-HDD case: the mountpoint directory exists and is
    // writable, but it is not the real volume.
    expect(() => assertDataVolumeMounted(dir)).toThrow(VolumeNotMountedError);
  });

  test("throws when the directory does not exist at all", () => {
    expect(() => assertDataVolumeMounted(join(dir, "nope"))).toThrow(VolumeNotMountedError);
  });

  test("error message names the sentinel path so the operator can fix it", () => {
    try {
      assertDataVolumeMounted(dir);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as Error).message).toContain(SENTINEL_FILENAME);
      expect((e as Error).message).toContain(dir);
    }
  });

  test("an empty nested mountpoint still fails", () => {
    const nested = join(dir, "signum-rewards");
    mkdirSync(nested);
    expect(() => assertDataVolumeMounted(nested)).toThrow(VolumeNotMountedError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/config/load.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/load.ts'`

- [ ] **Step 3: Implement**

Create `src/config/load.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "./schema.ts";
import type { AppConfig } from "./schema.ts";

/**
 * Written once by scripts/setup-volume.ts onto the real data volume.
 * Its absence means the volume is not mounted, however plausible the path looks.
 */
export const SENTINEL_FILENAME = ".volume-ok";

export class VolumeNotMountedError extends Error {
  constructor(dataDir: string) {
    super(
      `Data volume not mounted: ${join(dataDir, SENTINEL_FILENAME)} is missing.\n` +
        `Refusing to start, because opening SQLite here would silently create an\n` +
        `empty ledger and the entire block history would be re-accrued.\n` +
        `If the volume really is mounted and this is first-time setup, run:\n` +
        `  DATA_DIR=${dataDir} bun run scripts/setup-volume.ts`,
    );
    this.name = "VolumeNotMountedError";
  }
}

/**
 * Verifies the data directory is the real volume before anything opens a database.
 *
 * A bare existsSync(dataDir) check is NOT sufficient: an unmounted mountpoint is
 * an ordinary empty directory that exists and is writable. Only a file placed on
 * the volume itself distinguishes the two.
 */
export function assertDataVolumeMounted(dataDir: string): void {
  if (!existsSync(join(dataDir, SENTINEL_FILENAME))) {
    throw new VolumeNotMountedError(dataDir);
  }
}

export interface LedgerPaths {
  databasePath: string;
  walkerCachePath: string;
}

/**
 * Both caches live on the same volume, always. Split across volumes they can
 * desynchronise in the dangerous direction (walker cache ahead on the SD card,
 * ledger gone with the unmounted HDD), which silently SKIPS blocks. Kept
 * together they fail together, which the sentinel then catches.
 */
export function resolvePaths(cfg: AppConfig): LedgerPaths {
  return {
    databasePath: join(cfg.dataDir, "rewards.sqlite"),
    walkerCachePath: join(cfg.dataDir, "chainwalker.cache.json"),
  };
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): AppConfig {
  const cfg = parseConfig(env);
  assertDataVolumeMounted(cfg.dataDir);
  return cfg;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/config/load.test.ts`
Expected: `5 pass, 0 fail`

- [ ] **Step 5: Add the setup script**

Create `scripts/setup-volume.ts`:

```ts
/**
 * One-time setup: marks the data directory as the real volume.
 * Run this ONLY when the HDD is confirmed mounted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SENTINEL_FILENAME } from "../src/config/load.ts";

const dataDir = Bun.env.DATA_DIR;
if (!dataDir) {
  console.error("DATA_DIR is not set");
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
const sentinel = join(dataDir, SENTINEL_FILENAME);
writeFileSync(sentinel, `created ${new Date().toISOString()}\n`);
console.log(`Wrote ${sentinel}`);
console.log("Verify this file lives on the HDD, not the SD card:");
console.log(`  df -h ${dataDir}`);
```

- [ ] **Step 6: Commit**

```bash
git add src/config/load.ts scripts/setup-volume.ts tests/config/load.test.ts
git commit -m "feat: add config loading with mount sentinel guard"
```

---

## Task 7: Ledger database and schema

The DDL lives in a TypeScript module rather than a `.sql` file so tests can apply it to an in-memory database without resolving file paths.

**Files:**
- Create: `src/ledger/schema.ts`
- Create: `src/ledger/db.ts`
- Test: `tests/ledger/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ledger/db.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";

describe("openLedger", () => {
  test("creates every expected table and view", () => {
    const db = openLedger(":memory:");
    const names = db
      .query("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all() as { name: string }[];
    const set = new Set(names.map((n) => n.name));
    for (const expected of [
      "block_rewards",
      "batches",
      "batch_recipients",
      "mainnet_accounts",
      "health_samples",
      "alerts",
      "service_state",
      "unpaid_accruals",
    ]) {
      expect(set.has(expected)).toBe(true);
    }
    db.close();
  });

  test("applying the schema twice is harmless", () => {
    const db = openLedger(":memory:");
    expect(() => openLedger(":memory:")).not.toThrow();
    db.close();
  });

  test("enforces one open alert per kind", () => {
    const db = openLedger(":memory:");
    const ins = db.query(
      "INSERT INTO alerts (kind, severity, message, opened_at) VALUES (?1, 'critical', 'x', 1)",
    );
    ins.run("testnet_stalled");
    expect(() => ins.run("testnet_stalled")).toThrow();
    db.close();
  });

  test("allows a new alert of the same kind once the previous is resolved", () => {
    const db = openLedger(":memory:");
    db.run(
      "INSERT INTO alerts (kind, severity, message, opened_at) VALUES ('low_peers','warning','x',1)",
    );
    db.run("UPDATE alerts SET resolved_at = 2 WHERE kind = 'low_peers'");
    expect(() =>
      db.run(
        "INSERT INTO alerts (kind, severity, message, opened_at) VALUES ('low_peers','warning','x',3)",
      ),
    ).not.toThrow();
    db.close();
  });

  test("enables foreign keys", () => {
    const db = openLedger(":memory:");
    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/ledger/db.test.ts`
Expected: FAIL — `Cannot find module '../../src/ledger/db.ts'`

- [ ] **Step 3: Write the schema**

Create `src/ledger/schema.ts`:

```ts
/**
 * Ledger DDL. Applied on every startup; every statement is IF NOT EXISTS so it
 * is safe to re-run.
 *
 * Amounts are INTEGER planck: 1 SIGNA = 1e8 planck, so the JS safe-integer
 * range covers ~90 million SIGNA, far beyond anything this service moves.
 * Keeping them integers lets SQL SUM() stay exact.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS batches (
  id               INTEGER PRIMARY KEY,
  status           TEXT NOT NULL,
  recipient_count  INTEGER,
  total_planck     INTEGER,
  fee_planck       INTEGER,
  tx_id            TEXT,
  full_hash        TEXT,
  deadline_at      INTEGER,
  broadcast_at     INTEGER,
  confirmed_at     INTEGER,
  confirmed_height INTEGER,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_batches_status ON batches(status);

CREATE TABLE IF NOT EXISTS block_rewards (
  block_id             TEXT    PRIMARY KEY,
  height               INTEGER NOT NULL,
  block_timestamp      INTEGER NOT NULL,
  chain_day            TEXT    NOT NULL,
  generator_id         TEXT    NOT NULL,
  generator_public_key TEXT    NOT NULL,
  status               TEXT    NOT NULL,
  amount_planck        INTEGER NOT NULL DEFAULT 0,
  batch_id             INTEGER REFERENCES batches(id),
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_br_acct_day  ON block_rewards(generator_id, chain_day);
CREATE INDEX IF NOT EXISTS ix_br_day       ON block_rewards(chain_day);
CREATE INDEX IF NOT EXISTS ix_br_height    ON block_rewards(height);
CREATE INDEX IF NOT EXISTS ix_br_unbatched ON block_rewards(batch_id)
  WHERE status = 'accrued' AND batch_id IS NULL;

CREATE TABLE IF NOT EXISTS batch_recipients (
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  recipient_id  TEXT    NOT NULL,
  amount_planck INTEGER NOT NULL,
  PRIMARY KEY (batch_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS mainnet_accounts (
  account_id      TEXT PRIMARY KEY,
  public_key      TEXT,
  is_active       INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS health_samples (
  id                       INTEGER PRIMARY KEY,
  sampled_at               INTEGER NOT NULL,
  local_height             INTEGER,
  global_height            INTEGER,
  in_sync                  INTEGER,
  peer_count               INTEGER,
  seconds_since_last_block INTEGER,
  wallet_balance_planck    INTEGER,
  status                   TEXT
);
CREATE INDEX IF NOT EXISTS ix_health_time ON health_samples(sampled_at);

CREATE TABLE IF NOT EXISTS alerts (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL,
  severity          TEXT NOT NULL,
  message           TEXT NOT NULL,
  opened_at         INTEGER NOT NULL,
  resolved_at       INTEGER,
  notified_at       INTEGER,
  notified_channels TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_alert_open ON alerts(kind) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS service_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

CREATE VIEW IF NOT EXISTS unpaid_accruals AS
  SELECT * FROM block_rewards WHERE status = 'accrued' AND batch_id IS NULL;
`;
```

Note the table order: `batches` is created before `block_rewards` because the latter has a foreign key referencing it.

- [ ] **Step 4: Implement the opener**

Create `src/ledger/db.ts`:

```ts
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema.ts";

export type Ledger = Database;

/**
 * Opens (or creates) the ledger and applies the schema.
 *
 * Callers MUST have run assertDataVolumeMounted() first for a real path:
 * SQLite will happily create a database on an unmounted mountpoint.
 */
export function openLedger(path: string): Ledger {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(SCHEMA_SQL);
  return db;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test tests/ledger/db.test.ts`
Expected: `5 pass, 0 fail`

`PRAGMA journal_mode = WAL` is a no-op on `:memory:` databases rather than an error, so the same opener serves tests and production.

- [ ] **Step 6: Commit**

```bash
git add src/ledger/schema.ts src/ledger/db.ts tests/ledger/db.test.ts
git commit -m "feat: add ledger schema and database opener"
```

---

## Task 8: Block rewards repository — the idempotency core

The two properties tested here are what make "just restart it" a safe operation. Do not weaken them.

This module is the **conversion boundary**: it accepts and returns `Amount`, and converts to whole-planck integers only for the SQLite columns, so SQL `SUM()` stays exact.

**Files:**
- Create: `src/ledger/blockRewards.ts`
- Test: `tests/ledger/blockRewards.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ledger/blockRewards.test.ts`:

```ts
import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import {
  recordBlockReward,
  sumAccruedForAccountOnDay,
  sumAccruedGlobalOnDay,
  getBlockReward,
  countByStatus,
  getLastProcessedHeight,
} from "../../src/ledger/blockRewards.ts";
import type { BlockRewardInput } from "../../src/ledger/blockRewards.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

const input = (over: Partial<BlockRewardInput> = {}): BlockRewardInput => ({
  blockId: "block-1",
  height: 1000,
  blockTimestamp: 500_000,
  chainDay: "2026-03-14",
  generatorId: "acct-1",
  generatorPublicKey: "pubkey-1",
  status: "accrued",
  amount: Amount.fromSigna("2.5"),
  ...over,
});

describe("recordBlockReward", () => {
  test("inserts a new block and reports that it did", () => {
    expect(recordBlockReward(db, input())).toBe(true);
    expect(getBlockReward(db, "block-1")?.amount.getSigna()).toBe("2.5");
  });

  test("REPLAY SAFETY: recording the same block twice yields exactly one row", () => {
    expect(recordBlockReward(db, input())).toBe(true);
    expect(recordBlockReward(db, input())).toBe(false);
    const rows = db.query("SELECT COUNT(*) AS c FROM block_rewards").get() as { c: number };
    expect(rows.c).toBe(1);
  });

  test("REPLAY SAFETY: a replay cannot inflate the daily total", () => {
    recordBlockReward(db, input());
    recordBlockReward(db, input());
    recordBlockReward(db, input());
    expect(sumAccruedForAccountOnDay(db, "acct-1", "2026-03-14").getSigna()).toBe("2.5");
  });

  test("a different block at the same height is stored separately, not merged", () => {
    // A pop-off past the block offset would look like this. It must stay visible
    // as an anomaly rather than being silently absorbed.
    recordBlockReward(db, input({ blockId: "block-1" }));
    recordBlockReward(db, input({ blockId: "block-1-fork" }));
    const rows = db
      .query("SELECT COUNT(*) AS c FROM block_rewards WHERE height = 1000")
      .get() as { c: number };
    expect(rows.c).toBe(2);
  });

  test("stores whole planck, so decimal SIGNA survives the round trip exactly", () => {
    recordBlockReward(db, input({ amount: Amount.fromSigna("0.00000001") }));
    expect(getBlockReward(db, "block-1")?.amount.getPlanck()).toBe("1");
  });
});

describe("daily sums", () => {
  test("counts only accrued rows, never skipped ones", () => {
    recordBlockReward(db, input({ blockId: "b1" }));
    recordBlockReward(
      db,
      input({ blockId: "b2", status: "skipped_account_cap", amount: Amount.Zero() }),
    );
    recordBlockReward(
      db,
      input({ blockId: "b3", status: "skipped_no_mainnet_account", amount: Amount.Zero() }),
    );
    expect(sumAccruedForAccountOnDay(db, "acct-1", "2026-03-14").getSigna()).toBe("2.5");
  });

  test("separates accounts", () => {
    recordBlockReward(db, input({ blockId: "b1", generatorId: "acct-1" }));
    recordBlockReward(db, input({ blockId: "b2", generatorId: "acct-2" }));
    expect(sumAccruedForAccountOnDay(db, "acct-1", "2026-03-14").getSigna()).toBe("2.5");
    expect(sumAccruedGlobalOnDay(db, "2026-03-14").getSigna()).toBe("5");
  });

  test("separates chain days", () => {
    recordBlockReward(db, input({ blockId: "b1", chainDay: "2026-03-14" }));
    recordBlockReward(db, input({ blockId: "b2", chainDay: "2026-03-15" }));
    expect(sumAccruedGlobalOnDay(db, "2026-03-14").getSigna()).toBe("2.5");
    expect(sumAccruedGlobalOnDay(db, "2026-03-15").getSigna()).toBe("2.5");
  });

  test("returns zero rather than null for an empty day", () => {
    expect(sumAccruedGlobalOnDay(db, "2099-01-01").getPlanck()).toBe("0");
    expect(sumAccruedForAccountOnDay(db, "nobody", "2099-01-01").getPlanck()).toBe("0");
  });

  test("MUTATION SAFETY: each call returns an independent Amount", () => {
    recordBlockReward(db, input());
    const first = sumAccruedGlobalOnDay(db, "2026-03-14");
    first.add(Amount.fromSigna("1000"));
    expect(sumAccruedGlobalOnDay(db, "2026-03-14").getSigna()).toBe("2.5");
  });
});

describe("countByStatus and getLastProcessedHeight", () => {
  test("groups blocks by outcome for the status page", () => {
    recordBlockReward(db, input({ blockId: "b1" }));
    recordBlockReward(db, input({ blockId: "b2" }));
    recordBlockReward(
      db,
      input({ blockId: "b3", status: "skipped_no_mainnet_account", amount: Amount.Zero() }),
    );
    const counts = countByStatus(db);
    expect(counts.accrued).toBe(2);
    expect(counts.skipped_no_mainnet_account).toBe(1);
  });

  test("reports the highest observed height, or undefined when empty", () => {
    expect(getLastProcessedHeight(db)).toBeUndefined();
    recordBlockReward(db, input({ blockId: "b1", height: 10 }));
    recordBlockReward(db, input({ blockId: "b2", height: 42 }));
    expect(getLastProcessedHeight(db)).toBe(42);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/ledger/blockRewards.test.ts`
Expected: FAIL — `Cannot find module '../../src/ledger/blockRewards.ts'`

- [ ] **Step 3: Implement**

Create `src/ledger/blockRewards.ts`:

```ts
import type { Amount } from "@signumjs/util";
import type { Ledger } from "./db.ts";
import type { BlockRewardStatus, ChainDay } from "../domain/types.ts";
import { toPlanckInt, fromPlanckInt } from "../domain/money.ts";

export interface BlockRewardInput {
  blockId: string;
  height: number;
  blockTimestamp: number;
  chainDay: ChainDay;
  generatorId: string;
  generatorPublicKey: string;
  status: BlockRewardStatus;
  amount: Amount;
}

export interface BlockRewardRow extends BlockRewardInput {
  batchId: number | null;
  createdAt: number;
}

/**
 * Records the outcome of one observed block.
 *
 * INSERT OR IGNORE against the block_id primary key is the first of the two
 * idempotency layers: the chain walker's JSON cache and this database are
 * separate files that can disagree after a crash, so the walker may replay
 * blocks. A replay must be a silent no-op rather than a second accrual.
 *
 * @returns true if a new row was inserted, false if this block was already recorded.
 */
export function recordBlockReward(db: Ledger, input: BlockRewardInput): boolean {
  const result = db
    .query(
      `INSERT OR IGNORE INTO block_rewards
         (block_id, height, block_timestamp, chain_day, generator_id,
          generator_public_key, status, amount_planck, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .run(
      input.blockId,
      input.height,
      input.blockTimestamp,
      input.chainDay,
      input.generatorId,
      input.generatorPublicKey,
      input.status,
      toPlanckInt(input.amount),
      Math.floor(Date.now() / 1000),
    );
  return result.changes === 1;
}

export function getBlockReward(db: Ledger, blockId: string): BlockRewardRow | undefined {
  const row = db
    .query(
      `SELECT block_id, height, block_timestamp, chain_day, generator_id,
              generator_public_key, status, amount_planck, batch_id, created_at
         FROM block_rewards WHERE block_id = ?1`,
    )
    .get(blockId) as Record<string, unknown> | null;
  if (!row) return undefined;
  return {
    blockId: row.block_id as string,
    height: row.height as number,
    blockTimestamp: row.block_timestamp as number,
    chainDay: row.chain_day as string,
    generatorId: row.generator_id as string,
    generatorPublicKey: row.generator_public_key as string,
    status: row.status as BlockRewardStatus,
    amount: fromPlanckInt(row.amount_planck as number),
    batchId: (row.batch_id as number | null) ?? null,
    createdAt: row.created_at as number,
  };
}

export function sumAccruedForAccountOnDay(
  db: Ledger,
  generatorId: string,
  chainDay: ChainDay,
): Amount {
  const row = db
    .query(
      `SELECT COALESCE(SUM(amount_planck), 0) AS total
         FROM block_rewards
        WHERE generator_id = ?1 AND chain_day = ?2 AND status = 'accrued'`,
    )
    .get(generatorId, chainDay) as { total: number };
  return fromPlanckInt(row.total);
}

export function sumAccruedGlobalOnDay(db: Ledger, chainDay: ChainDay): Amount {
  const row = db
    .query(
      `SELECT COALESCE(SUM(amount_planck), 0) AS total
         FROM block_rewards WHERE chain_day = ?1 AND status = 'accrued'`,
    )
    .get(chainDay) as { total: number };
  return fromPlanckInt(row.total);
}

export function countByStatus(db: Ledger): Partial<Record<BlockRewardStatus, number>> {
  const rows = db
    .query("SELECT status, COUNT(*) AS c FROM block_rewards GROUP BY status")
    .all() as { status: BlockRewardStatus; c: number }[];
  const out: Partial<Record<BlockRewardStatus, number>> = {};
  for (const r of rows) out[r.status] = r.c;
  return out;
}

export function getLastProcessedHeight(db: Ledger): number | undefined {
  const row = db.query("SELECT MAX(height) AS h FROM block_rewards").get() as {
    h: number | null;
  };
  return row.h ?? undefined;
}
```

Each read constructs a fresh `Amount`, so a caller mutating a returned value cannot corrupt anything shared.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/ledger/blockRewards.test.ts`
Expected: `12 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/ledger/blockRewards.ts tests/ledger/blockRewards.test.ts
git commit -m "feat: add block rewards repository with replay-safe accrual"
```

---

## Task 9: Batches repository — claim exclusivity

This is the second idempotency layer: an accrual can belong to at most one batch. Claiming happens in a single transaction, so a crash mid-claim rolls back entirely.

**Files:**
- Create: `src/ledger/batches.ts`
- Test: `tests/ledger/batches.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ledger/batches.test.ts`:

```ts
import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import {
  aggregateUnpaidByRecipient,
  claimBatch,
  releaseBatch,
  getBatch,
  EmptyClaimError,
} from "../../src/ledger/batches.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

/** Records an accrued block for `generatorId`. */
const accrue = (blockId: string, generatorId: string, signa: string) =>
  recordBlockReward(db, {
    blockId,
    height: Number(blockId.replace(/\D/g, "")) || 1,
    blockTimestamp: 500_000,
    chainDay: "2026-03-14",
    generatorId,
    generatorPublicKey: `pk-${generatorId}`,
    status: "accrued",
    amount: Amount.fromSigna(signa),
  });

describe("aggregateUnpaidByRecipient", () => {
  test("sums unpaid accruals per recipient", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-1", "2.5");
    accrue("b3", "acct-2", "2.5");
    const byId = new Map(aggregateUnpaidByRecipient(db).map((r) => [r.recipientId, r]));
    expect(byId.get("acct-1")?.amount.getSigna()).toBe("5");
    expect(byId.get("acct-1")?.accrualCount).toBe(2);
    expect(byId.get("acct-2")?.amount.getSigna()).toBe("2.5");
  });

  test("excludes skipped blocks", () => {
    accrue("b1", "acct-1", "2.5");
    recordBlockReward(db, {
      blockId: "b2",
      height: 2,
      blockTimestamp: 1,
      chainDay: "2026-03-14",
      generatorId: "acct-1",
      generatorPublicKey: "pk",
      status: "skipped_account_cap",
      amount: Amount.Zero(),
    });
    expect(aggregateUnpaidByRecipient(db)[0]?.amount.getSigna()).toBe("2.5");
  });

  test("returns an empty array when there is nothing to pay", () => {
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
  });
});

describe("claimBatch", () => {
  test("creates a batch and stamps the claimed accruals", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-1", "2.5");
    accrue("b3", "acct-2", "10");

    const claimed = claimBatch(db, { recipientIds: ["acct-1", "acct-2"], deadlineAt: 999 });

    expect(claimed.total.getSigna()).toBe("15");
    expect(claimed.recipients).toHaveLength(2);
    expect(getBatch(db, claimed.batchId)?.status).toBe("pending");
  });

  test("EXCLUSIVITY: claimed accruals disappear from the unpaid pool", () => {
    accrue("b1", "acct-1", "2.5");
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 });
    expect(aggregateUnpaidByRecipient(db)).toEqual([]);
  });

  test("EXCLUSIVITY: a second claim cannot take the same accruals", () => {
    accrue("b1", "acct-1", "2.5");
    const first = claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 });
    expect(first.total.getSigna()).toBe("2.5");
    expect(() => claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 })).toThrow(
      EmptyClaimError,
    );
  });

  test("claims only the named recipients, leaving others unpaid", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-2", "2.5");
    claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 });
    const remaining = aggregateUnpaidByRecipient(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.recipientId).toBe("acct-2");
  });

  test("throws rather than creating an empty batch", () => {
    expect(() => claimBatch(db, { recipientIds: [], deadlineAt: 999 })).toThrow(EmptyClaimError);
    const count = db.query("SELECT COUNT(*) AS c FROM batches").get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("ATOMICITY: a failed claim leaves no batch and no stamped accruals", () => {
    accrue("b1", "acct-1", "2.5");
    expect(() => claimBatch(db, { recipientIds: ["ghost"], deadlineAt: 999 })).toThrow(
      EmptyClaimError,
    );
    const after = db.query("SELECT COUNT(*) AS c FROM batches").get() as { c: number };
    expect(after.c).toBe(0);
    expect(aggregateUnpaidByRecipient(db)).toHaveLength(1);
  });
});

describe("releaseBatch", () => {
  test("returns accruals to the unpaid pool and marks the batch failed", () => {
    accrue("b1", "acct-1", "2.5");
    const claimed = claimBatch(db, { recipientIds: ["acct-1"], deadlineAt: 999 });
    releaseBatch(db, claimed.batchId, "deadline expired with no matching transaction");

    expect(getBatch(db, claimed.batchId)?.status).toBe("failed");
    const pool = aggregateUnpaidByRecipient(db);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.amount.getSigna()).toBe("2.5");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/ledger/batches.test.ts`
Expected: FAIL — `Cannot find module '../../src/ledger/batches.ts'`

- [ ] **Step 3: Implement**

Create `src/ledger/batches.ts`:

```ts
import type { Amount } from "@signumjs/util";
import type { Ledger } from "./db.ts";
import type { RecipientAmount } from "../domain/types.ts";
import { fromPlanckInt } from "../domain/money.ts";

export type BatchStatus = "pending" | "broadcast" | "confirmed" | "failed";

export class EmptyClaimError extends Error {
  constructor() {
    super("No unpaid accruals matched the requested recipients; nothing to claim");
    this.name = "EmptyClaimError";
  }
}

export interface UnpaidAggregate {
  recipientId: string;
  amount: Amount;
  accrualCount: number;
  /** Used for oldest-first fairness ordering during composition. */
  oldestCreatedAt: number;
}

export interface ClaimedBatch {
  batchId: number;
  recipients: RecipientAmount[];
  total: Amount;
}

export interface BatchRow {
  id: number;
  status: BatchStatus;
  recipientCount: number | null;
  total: Amount | null;
  txId: string | null;
  deadlineAt: number | null;
  createdAt: number;
  lastError: string | null;
}

export function aggregateUnpaidByRecipient(db: Ledger): UnpaidAggregate[] {
  const rows = db
    .query(
      `SELECT generator_id       AS recipientId,
              SUM(amount_planck) AS totalPlanck,
              COUNT(*)           AS accrualCount,
              MIN(created_at)    AS oldestCreatedAt
         FROM unpaid_accruals
        GROUP BY generator_id`,
    )
    .all() as { recipientId: string; totalPlanck: number; accrualCount: number; oldestCreatedAt: number }[];

  return rows.map((r) => ({
    recipientId: r.recipientId,
    amount: fromPlanckInt(r.totalPlanck),
    accrualCount: r.accrualCount,
    oldestCreatedAt: r.oldestCreatedAt,
  }));
}

/**
 * Atomically creates a batch and claims the named recipients' unpaid accruals.
 *
 * This is the second idempotency layer: block_rewards.batch_id moves from NULL
 * to a batch id exactly once, so an accrual can never be paid twice regardless
 * of what the chain walker replays. The whole thing is one transaction, so a
 * crash part-way through leaves neither a batch nor stamped accruals.
 */
export function claimBatch(
  db: Ledger,
  params: { recipientIds: string[]; deadlineAt: number },
): ClaimedBatch {
  const run = db.transaction((): ClaimedBatch => {
    const now = Math.floor(Date.now() / 1000);

    const insertBatch = db
      .query(
        `INSERT INTO batches (status, deadline_at, created_at, attempt_count)
         VALUES ('pending', ?1, ?2, 0)`,
      )
      .run(params.deadlineAt, now);
    const batchId = Number(insertBatch.lastInsertRowid);

    const sumStmt = db.query(
      `SELECT COALESCE(SUM(amount_planck), 0) AS total
         FROM unpaid_accruals WHERE generator_id = ?1`,
    );
    const insertRecipient = db.query(
      `INSERT INTO batch_recipients (batch_id, recipient_id, amount_planck) VALUES (?1, ?2, ?3)`,
    );
    const stampAccruals = db.query(
      `UPDATE block_rewards SET batch_id = ?1
        WHERE generator_id = ?2 AND status = 'accrued' AND batch_id IS NULL`,
    );

    const recipients: RecipientAmount[] = [];
    let totalPlanck = 0;

    for (const recipientId of params.recipientIds) {
      const { total } = sumStmt.get(recipientId) as { total: number };
      if (total <= 0) continue;
      insertRecipient.run(batchId, recipientId, total);
      stampAccruals.run(batchId, recipientId);
      recipients.push({ recipientId, amount: fromPlanckInt(total) });
      totalPlanck += total;
    }

    // Throwing inside db.transaction rolls back the batch row created above.
    if (recipients.length === 0) throw new EmptyClaimError();

    db.query(`UPDATE batches SET recipient_count = ?1, total_planck = ?2 WHERE id = ?3`).run(
      recipients.length,
      totalPlanck,
      batchId,
    );

    return { batchId, recipients, total: fromPlanckInt(totalPlanck) };
  });

  return run();
}

/** Returns a failed batch's accruals to the unpaid pool so the next run retries them. */
export function releaseBatch(db: Ledger, batchId: number, reason: string): void {
  const run = db.transaction(() => {
    db.query(`UPDATE block_rewards SET batch_id = NULL WHERE batch_id = ?1`).run(batchId);
    db.query(`UPDATE batches SET status = 'failed', last_error = ?1 WHERE id = ?2`).run(
      reason,
      batchId,
    );
  });
  run();
}

function toBatchRow(row: Record<string, unknown>): BatchRow {
  const totalPlanck = row.total_planck as number | null;
  return {
    id: row.id as number,
    status: row.status as BatchStatus,
    recipientCount: (row.recipient_count as number | null) ?? null,
    total: totalPlanck === null ? null : fromPlanckInt(totalPlanck),
    txId: (row.tx_id as string | null) ?? null,
    deadlineAt: (row.deadline_at as number | null) ?? null,
    createdAt: row.created_at as number,
    lastError: (row.last_error as string | null) ?? null,
  };
}

const BATCH_COLUMNS = `id, status, recipient_count, total_planck, tx_id, deadline_at, created_at, last_error`;

export function getBatch(db: Ledger, batchId: number): BatchRow | undefined {
  const row = db
    .query(`SELECT ${BATCH_COLUMNS} FROM batches WHERE id = ?1`)
    .get(batchId) as Record<string, unknown> | null;
  return row ? toBatchRow(row) : undefined;
}

export function listRecentBatches(db: Ledger, limit: number): BatchRow[] {
  const rows = db
    .query(`SELECT ${BATCH_COLUMNS} FROM batches ORDER BY id DESC LIMIT ?1`)
    .all(limit) as Record<string, unknown>[];
  return rows.map(toBatchRow);
}

/** Total actually sent today, wall-clock, for the per-day spend rail. */
export function sumBroadcastSinceWallClock(db: Ledger, sinceEpochSeconds: number): Amount {
  const row = db
    .query(
      `SELECT COALESCE(SUM(total_planck), 0) AS total
         FROM batches
        WHERE status IN ('broadcast','confirmed') AND created_at >= ?1`,
    )
    .get(sinceEpochSeconds) as { total: number };
  return fromPlanckInt(row.total);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/ledger/batches.test.ts`
Expected: `9 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/ledger/batches.ts tests/ledger/batches.test.ts
git commit -m "feat: add batch repository with atomic accrual claiming"
```

---

## Task 10: Service state and alerts repositories

**Files:**
- Create: `src/ledger/state.ts`
- Create: `src/ledger/alerts.ts`
- Test: `tests/ledger/state.test.ts`
- Test: `tests/ledger/alerts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/ledger/state.test.ts`:

```ts
import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import {
  getState,
  setState,
  isPayoutsPaused,
  setPayoutsPaused,
  isKillSwitchTripped,
  tripKillSwitch,
  clearKillSwitch,
  getKillSwitchReason,
} from "../../src/ledger/state.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

describe("service state", () => {
  test("returns undefined for an unset key", () => {
    expect(getState(db, "nothing")).toBeUndefined();
  });

  test("round-trips a value and overwrites on second write", () => {
    setState(db, "k", "v1");
    expect(getState(db, "k")).toBe("v1");
    setState(db, "k", "v2");
    expect(getState(db, "k")).toBe("v2");
  });

  test("payouts are not paused by default", () => {
    expect(isPayoutsPaused(db)).toBe(false);
  });

  test("pausing and resuming payouts", () => {
    setPayoutsPaused(db, true);
    expect(isPayoutsPaused(db)).toBe(true);
    setPayoutsPaused(db, false);
    expect(isPayoutsPaused(db)).toBe(false);
  });

  test("kill switch is untripped by default and records its reason when tripped", () => {
    expect(isKillSwitchTripped(db)).toBe(false);
    tripKillSwitch(db, "per_batch rail exceeded");
    expect(isKillSwitchTripped(db)).toBe(true);
    expect(getKillSwitchReason(db)).toBe("per_batch rail exceeded");
  });

  test("clearing the kill switch is explicit and removes the reason", () => {
    tripKillSwitch(db, "boom");
    clearKillSwitch(db);
    expect(isKillSwitchTripped(db)).toBe(false);
    expect(getKillSwitchReason(db)).toBeUndefined();
  });
});
```

Create `tests/ledger/alerts.test.ts`:

```ts
import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import {
  openAlert,
  resolveAlert,
  listOpenAlerts,
  listUnnotifiedAlerts,
  markAlertNotified,
} from "../../src/ledger/alerts.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

describe("alerts", () => {
  test("opening an alert records it as open", () => {
    openAlert(db, { kind: "testnet_stalled", severity: "critical", message: "no blocks 17m" });
    const open = listOpenAlerts(db);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("testnet_stalled");
  });

  test("DEDUP: opening the same kind twice does not create a second incident", () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "2 peers" });
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });
    expect(listOpenAlerts(db)).toHaveLength(1);
  });

  test("DEDUP: a flapping condition cannot spam, even across many attempts", () => {
    for (let i = 0; i < 50; i++) {
      openAlert(db, { kind: "low_peers", severity: "warning", message: `attempt ${i}` });
    }
    expect(listOpenAlerts(db)).toHaveLength(1);
  });

  test("resolving lets the same kind open again as a new incident", () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "first" });
    resolveAlert(db, "low_peers");
    expect(listOpenAlerts(db)).toHaveLength(0);
    openAlert(db, { kind: "low_peers", severity: "warning", message: "second" });
    expect(listOpenAlerts(db)).toHaveLength(1);
    const all = db.query("SELECT COUNT(*) AS c FROM alerts").get() as { c: number };
    expect(all.c).toBe(2);
  });

  test("resolving an alert that is not open is harmless", () => {
    expect(() => resolveAlert(db, "never_opened")).not.toThrow();
  });

  test("unnotified alerts are queued until marked, which supports offline retry", () => {
    openAlert(db, { kind: "wallet_low", severity: "warning", message: "low" });
    expect(listUnnotifiedAlerts(db)).toHaveLength(1);
    const alert = listUnnotifiedAlerts(db)[0];
    expect(alert).toBeDefined();
    markAlertNotified(db, alert!.id, ["telegram", "discord"]);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/ledger/state.test.ts tests/ledger/alerts.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement service state**

Create `src/ledger/state.ts`:

```ts
import type { Ledger } from "./db.ts";

const PAYOUTS_PAUSED = "payouts_paused";
const KILL_SWITCH = "kill_switch";
const KILL_SWITCH_REASON = "kill_switch_reason";

export function getState(db: Ledger, key: string): string | undefined {
  const row = db.query("SELECT value FROM service_state WHERE key = ?1").get(key) as
    | { value: string | null }
    | null;
  return row?.value ?? undefined;
}

export function setState(db: Ledger, key: string, value: string): void {
  db.query(
    `INSERT INTO service_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Math.floor(Date.now() / 1000));
}

export function deleteState(db: Ledger, key: string): void {
  db.query("DELETE FROM service_state WHERE key = ?1").run(key);
}

export function isPayoutsPaused(db: Ledger): boolean {
  return getState(db, PAYOUTS_PAUSED) === "true";
}

export function setPayoutsPaused(db: Ledger, paused: boolean): void {
  setState(db, PAYOUTS_PAUSED, paused ? "true" : "false");
}

export function isKillSwitchTripped(db: Ledger): boolean {
  return getState(db, KILL_SWITCH) === "true";
}

/**
 * Halts all payouts. Deliberately has no automatic reset: a rail violation means
 * something is wrong that a human should look at. Accrual and indexing continue,
 * so miners keep earning and only delivery pauses.
 */
export function tripKillSwitch(db: Ledger, reason: string): void {
  setState(db, KILL_SWITCH, "true");
  setState(db, KILL_SWITCH_REASON, reason);
}

export function clearKillSwitch(db: Ledger): void {
  setState(db, KILL_SWITCH, "false");
  deleteState(db, KILL_SWITCH_REASON);
}

export function getKillSwitchReason(db: Ledger): string | undefined {
  return getState(db, KILL_SWITCH_REASON);
}
```

- [ ] **Step 4: Implement alerts**

Create `src/ledger/alerts.ts`:

```ts
import type { Ledger } from "./db.ts";

export type Severity = "warning" | "critical";

export interface AlertRow {
  id: number;
  kind: string;
  severity: Severity;
  message: string;
  openedAt: number;
  resolvedAt: number | null;
}

/**
 * Opens an incident, or does nothing if one of this kind is already open.
 *
 * Dedup is enforced by the partial unique index ix_alert_open rather than by
 * this code, so a flapping condition physically cannot spam the operator even
 * if a caller loops.
 */
export function openAlert(
  db: Ledger,
  params: { kind: string; severity: Severity; message: string },
): void {
  db.query(
    `INSERT OR IGNORE INTO alerts (kind, severity, message, opened_at)
     VALUES (?1, ?2, ?3, ?4)`,
  ).run(params.kind, params.severity, params.message, Math.floor(Date.now() / 1000));
}

export function resolveAlert(db: Ledger, kind: string): void {
  db.query("UPDATE alerts SET resolved_at = ?1 WHERE kind = ?2 AND resolved_at IS NULL").run(
    Math.floor(Date.now() / 1000),
    kind,
  );
}

function toRow(row: Record<string, unknown>): AlertRow {
  return {
    id: row.id as number,
    kind: row.kind as string,
    severity: row.severity as Severity,
    message: row.message as string,
    openedAt: row.opened_at as number,
    resolvedAt: (row.resolved_at as number | null) ?? null,
  };
}

export function listOpenAlerts(db: Ledger): AlertRow[] {
  const rows = db
    .query(
      `SELECT id, kind, severity, message, opened_at, resolved_at
         FROM alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(toRow);
}

/**
 * Alerts not yet delivered to any channel.
 *
 * If the Pi has no internet, notification fails and rows stay here, so they are
 * delivered on reconnect rather than lost.
 */
export function listUnnotifiedAlerts(db: Ledger): AlertRow[] {
  const rows = db
    .query(
      `SELECT id, kind, severity, message, opened_at, resolved_at
         FROM alerts WHERE notified_at IS NULL ORDER BY opened_at ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(toRow);
}

export function markAlertNotified(db: Ledger, id: number, channels: string[]): void {
  db.query("UPDATE alerts SET notified_at = ?1, notified_channels = ?2 WHERE id = ?3").run(
    Math.floor(Date.now() / 1000),
    channels.join(","),
    id,
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/ledger/state.test.ts tests/ledger/alerts.test.ts`
Expected: `12 pass, 0 fail`

- [ ] **Step 6: Commit**

```bash
git add src/ledger/state.ts src/ledger/alerts.ts tests/ledger/state.test.ts tests/ledger/alerts.test.ts
git commit -m "feat: add service state and deduplicated alert repositories"
```

---

## Task 11: Eligibility

Two pieces: a **pure decision function** (exhaustively testable) and a **TTL cache** over mainnet account lookups so public nodes are not hit on every block.

**Files:**
- Create: `src/eligibility/eligibility.ts`
- Create: `src/ledger/mainnetAccounts.ts`
- Test: `tests/eligibility/eligibility.test.ts`
- Test: `tests/ledger/mainnetAccounts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/eligibility/eligibility.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { decideEligibility } from "../../src/eligibility/eligibility.ts";

describe("decideEligibility", () => {
  test("eligible when the mainnet account is active with a matching public key", () => {
    expect(
      decideEligibility({
        generatorPublicKey: "abc123",
        excluded: false,
        mainnetAccount: { isActive: true, publicKey: "abc123" },
      }),
    ).toEqual({ kind: "eligible" });
  });

  test("ineligible when no mainnet account exists", () => {
    expect(
      decideEligibility({
        generatorPublicKey: "abc123",
        excluded: false,
        mainnetAccount: undefined,
      }),
    ).toEqual({ kind: "ineligible", status: "skipped_no_mainnet_account" });
  });

  test("ineligible when the mainnet account exists but has no public key set", () => {
    // An account that has only ever received funds is not activated.
    expect(
      decideEligibility({
        generatorPublicKey: "abc123",
        excluded: false,
        mainnetAccount: { isActive: false, publicKey: null },
      }),
    ).toEqual({ kind: "ineligible", status: "skipped_no_mainnet_account" });
  });

  test("ANOMALY: ineligible when public keys differ despite the same account id", () => {
    // Account ids derive from public keys, so this should be impossible.
    // It is treated as an anomaly rather than a routine skip.
    expect(
      decideEligibility({
        generatorPublicKey: "abc123",
        excluded: false,
        mainnetAccount: { isActive: true, publicKey: "totally-different" },
      }),
    ).toEqual({ kind: "ineligible", status: "skipped_pubkey_mismatch" });
  });

  test("public key comparison ignores case, since hex casing varies by source", () => {
    expect(
      decideEligibility({
        generatorPublicKey: "ABC123",
        excluded: false,
        mainnetAccount: { isActive: true, publicKey: "abc123" },
      }),
    ).toEqual({ kind: "eligible" });
  });

  test("exclusion wins over everything else", () => {
    expect(
      decideEligibility({
        generatorPublicKey: "abc123",
        excluded: true,
        mainnetAccount: { isActive: true, publicKey: "abc123" },
      }),
    ).toEqual({ kind: "ineligible", status: "skipped_excluded" });
  });
});
```

Create `tests/ledger/mainnetAccounts.test.ts`:

```ts
import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { getFreshAccount, upsertAccount } from "../../src/ledger/mainnetAccounts.ts";

let db: Ledger;
const TTL = { positiveSeconds: 86_400, negativeSeconds: 3_600 };

beforeEach(() => {
  db = openLedger(":memory:");
});

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
    // still fresh just under the negative TTL
    expect(getFreshAccount(db, "acct-1", TTL, 1_000_000 + 3_599)?.isActive).toBe(false);
    // stale just past it, well before the positive TTL would have expired
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/eligibility/eligibility.test.ts tests/ledger/mainnetAccounts.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement the pure decision**

Create `src/eligibility/eligibility.ts`:

```ts
import type { BlockRewardStatus } from "../domain/types.ts";

export interface MainnetAccountFacts {
  /** True when the account exists on mainnet AND has a public key set. */
  isActive: boolean;
  publicKey: string | null;
}

export interface EligibilityInput {
  generatorPublicKey: string;
  excluded: boolean;
  mainnetAccount: MainnetAccountFacts | undefined;
}

export type EligibilityDecision =
  | { kind: "eligible" }
  | {
      kind: "ineligible";
      status: Extract<
        BlockRewardStatus,
        "skipped_no_mainnet_account" | "skipped_pubkey_mismatch" | "skipped_excluded"
      >;
    };

/**
 * Decides whether a testnet block generator may be paid on mainnet.
 *
 * Signum account ids derive from the public key, so an id match already implies
 * a key match. The explicit comparison closes the only theoretical hole for the
 * cost of one string compare, and a mismatch is surfaced as its own status so it
 * can be alerted on rather than blending into ordinary skips.
 */
export function decideEligibility(input: EligibilityInput): EligibilityDecision {
  if (input.excluded) {
    return { kind: "ineligible", status: "skipped_excluded" };
  }
  const account = input.mainnetAccount;
  if (!account || !account.isActive || !account.publicKey) {
    return { kind: "ineligible", status: "skipped_no_mainnet_account" };
  }
  if (account.publicKey.toLowerCase() !== input.generatorPublicKey.toLowerCase()) {
    return { kind: "ineligible", status: "skipped_pubkey_mismatch" };
  }
  return { kind: "eligible" };
}
```

- [ ] **Step 4: Implement the cache**

Create `src/ledger/mainnetAccounts.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/eligibility/eligibility.test.ts tests/ledger/mainnetAccounts.test.ts`
Expected: `11 pass, 0 fail`

- [ ] **Step 6: Commit**

```bash
git add src/eligibility/eligibility.ts src/ledger/mainnetAccounts.ts tests/eligibility tests/ledger/mainnetAccounts.test.ts
git commit -m "feat: add eligibility decision and mainnet account TTL cache"
```

---

## Task 12: Indexer — block handler and walker wiring

**Files:**
- Create: `src/indexer/blockHandler.ts`
- Create: `src/indexer/indexer.ts`
- Test: `tests/indexer/blockHandler.test.ts`
- Test: `tests/indexer/walker.integration.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `tests/indexer/blockHandler.test.ts`:

```ts
import { test, expect, describe, beforeEach } from "bun:test";
import type { Block } from "@signumjs/core";
import { Amount, ChainTime } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { getBlockReward, sumAccruedGlobalOnDay } from "../../src/ledger/blockRewards.ts";
import { createBlockHandler } from "../../src/indexer/blockHandler.ts";
import type { RewardPolicyConfig } from "../../src/domain/policy.ts";
import type { MainnetAccountFacts } from "../../src/eligibility/eligibility.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

/** Deliberately tiny caps so the cap paths are reachable in a few blocks. */
const policy: RewardPolicyConfig = {
  rewardPerBlock: Amount.fromSigna("2.5"),
  accountDailyCap: Amount.fromSigna("5"), // two blocks per account per day
  globalDailyBudget: Amount.fromSigna("7.5"), // three blocks total per day
};

const DAY = "2026-03-14";
const tsFor = (isoDate: string): number =>
  ChainTime.fromDate(new Date(`${isoDate}T12:00:00Z`)).getChainTimestamp();

/** Builds a Block with only the fields the handler reads. */
const makeBlock = (over: Partial<Block>): Block =>
  ({
    block: "block-1",
    height: 1000,
    timestamp: tsFor(DAY),
    generator: "acct-1",
    generatorRS: "TS-XXXX-XXXX-XXXX-XXXXX",
    generatorPublicKey: "pk-acct-1",
    ...over,
  }) as unknown as Block;

const activeAccount: MainnetAccountFacts = { isActive: true, publicKey: "pk-acct-1" };

const handlerWith = (opts: {
  lookup?: (id: string) => Promise<MainnetAccountFacts | undefined>;
  isExcluded?: (id: string) => boolean;
}) =>
  createBlockHandler({
    db,
    policy,
    lookupMainnetAccount: opts.lookup ?? (async () => activeAccount),
    isExcluded: opts.isExcluded ?? (() => false),
  });

describe("block handler", () => {
  test("accrues a reward for an eligible generator", async () => {
    await handlerWith({})(makeBlock({}));
    const row = getBlockReward(db, "block-1");
    expect(row?.status).toBe("accrued");
    expect(row?.amount.getSigna()).toBe("2.5");
    expect(row?.chainDay).toBe(DAY);
  });

  test("records a skip when the generator has no mainnet account", async () => {
    await handlerWith({ lookup: async () => undefined })(makeBlock({}));
    const row = getBlockReward(db, "block-1");
    expect(row?.status).toBe("skipped_no_mainnet_account");
    expect(row?.amount.getPlanck()).toBe("0");
  });

  test("records a skip for an excluded account", async () => {
    await handlerWith({ isExcluded: () => true })(makeBlock({}));
    expect(getBlockReward(db, "block-1")?.status).toBe("skipped_excluded");
  });

  test("records a skip when public keys disagree", async () => {
    await handlerWith({
      lookup: async () => ({ isActive: true, publicKey: "some-other-key" }),
    })(makeBlock({}));
    expect(getBlockReward(db, "block-1")?.status).toBe("skipped_pubkey_mismatch");
  });

  test("enforces the per-account daily cap across blocks", async () => {
    const handler = handlerWith({});
    await handler(makeBlock({ block: "b1", height: 1 }));
    await handler(makeBlock({ block: "b2", height: 2 }));
    await handler(makeBlock({ block: "b3", height: 3 })); // would exceed 5 SIGNA
    expect(getBlockReward(db, "b3")?.status).toBe("skipped_account_cap");
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("5");
  });

  test("enforces the global daily budget across accounts", async () => {
    const handler = handlerWith({
      lookup: async (id) => ({ isActive: true, publicKey: `pk-${id}` }),
    });
    await handler(makeBlock({ block: "b1", height: 1, generator: "a", generatorPublicKey: "pk-a" }));
    await handler(makeBlock({ block: "b2", height: 2, generator: "a", generatorPublicKey: "pk-a" }));
    await handler(makeBlock({ block: "b3", height: 3, generator: "b", generatorPublicKey: "pk-b" }));
    await handler(makeBlock({ block: "b4", height: 4, generator: "c", generatorPublicKey: "pk-c" }));
    expect(getBlockReward(db, "b4")?.status).toBe("skipped_global_cap");
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("7.5");
  });

  test("CHAIN-DAY: caps reset on the next chain day, not the next wall-clock day", async () => {
    const handler = handlerWith({});
    await handler(makeBlock({ block: "b1", height: 1, timestamp: tsFor("2026-03-14") }));
    await handler(makeBlock({ block: "b2", height: 2, timestamp: tsFor("2026-03-14") }));
    await handler(makeBlock({ block: "b3", height: 3, timestamp: tsFor("2026-03-14") }));
    expect(getBlockReward(db, "b3")?.status).toBe("skipped_account_cap");
    // The same block on the NEXT chain day is fine.
    await handler(makeBlock({ block: "b4", height: 4, timestamp: tsFor("2026-03-15") }));
    expect(getBlockReward(db, "b4")?.status).toBe("accrued");
  });

  test("REPLAY: handling the same block twice does not double-accrue", async () => {
    const handler = handlerWith({});
    await handler(makeBlock({}));
    await handler(makeBlock({}));
    expect(sumAccruedGlobalOnDay(db, DAY).getSigna()).toBe("2.5");
  });

  test("REPLAY: a replayed block does not re-query the mainnet account", async () => {
    let lookups = 0;
    const handler = handlerWith({
      lookup: async () => {
        lookups++;
        return activeAccount;
      },
    });
    await handler(makeBlock({}));
    await handler(makeBlock({}));
    expect(lookups).toBe(1);
  });

  test("MUTATION SAFETY: the policy config is unchanged after many blocks", async () => {
    const handler = handlerWith({});
    for (let i = 0; i < 5; i++) {
      await handler(makeBlock({ block: `m${i}`, height: i }));
    }
    expect(policy.rewardPerBlock.getSigna()).toBe("2.5");
    expect(policy.accountDailyCap.getSigna()).toBe("5");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/indexer/blockHandler.test.ts`
Expected: FAIL — `Cannot find module '../../src/indexer/blockHandler.ts'`

- [ ] **Step 3: Implement the handler**

Create `src/indexer/blockHandler.ts`:

```ts
import type { Block } from "@signumjs/core";
import { Amount } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { RewardPolicyConfig } from "../domain/policy.ts";
import type { MainnetAccountFacts } from "../eligibility/eligibility.ts";
import { decideEligibility } from "../eligibility/eligibility.ts";
import { decideReward } from "../domain/policy.ts";
import { toChainDay } from "../domain/chainDay.ts";
import {
  getBlockReward,
  recordBlockReward,
  sumAccruedForAccountOnDay,
  sumAccruedGlobalOnDay,
} from "../ledger/blockRewards.ts";

export interface BlockHandlerDeps {
  db: Ledger;
  policy: RewardPolicyConfig;
  lookupMainnetAccount: (accountId: string) => Promise<MainnetAccountFacts | undefined>;
  isExcluded: (accountId: string) => boolean;
}

/**
 * Scores one observed block and records the outcome.
 *
 * Every block produces a row, including skips: the status page answers
 * "why am I not getting paid?" from these rows, and dropping them would turn
 * that question into a support burden.
 *
 * The early return on an already-recorded block is an optimisation only. The
 * real guarantee against double-accrual is the INSERT OR IGNORE in
 * recordBlockReward, which holds even if two handlers race.
 */
export function createBlockHandler(deps: BlockHandlerDeps) {
  return async function handleBlock(block: Block): Promise<void> {
    const blockId = block.block;
    if (getBlockReward(deps.db, blockId)) return;

    const chainDay = toChainDay(block.timestamp);
    const generatorId = block.generator;
    const excluded = deps.isExcluded(generatorId);

    const base = {
      blockId,
      height: block.height,
      blockTimestamp: block.timestamp,
      chainDay,
      generatorId,
      generatorPublicKey: block.generatorPublicKey,
    };

    const mainnetAccount = excluded ? undefined : await deps.lookupMainnetAccount(generatorId);

    const eligibility = decideEligibility({
      generatorPublicKey: block.generatorPublicKey,
      excluded,
      mainnetAccount,
    });

    if (eligibility.kind === "ineligible") {
      recordBlockReward(deps.db, {
        ...base,
        status: eligibility.status,
        amount: Amount.Zero(),
      });
      return;
    }

    const decision = decideReward(deps.policy, {
      accountAccruedToday: sumAccruedForAccountOnDay(deps.db, generatorId, chainDay),
      globalAccruedToday: sumAccruedGlobalOnDay(deps.db, chainDay),
    });

    if (decision.kind === "skip") {
      recordBlockReward(deps.db, { ...base, status: decision.status, amount: Amount.Zero() });
      return;
    }

    recordBlockReward(deps.db, { ...base, status: "accrued", amount: decision.amount });
  };
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `bun test tests/indexer/blockHandler.test.ts`
Expected: `10 pass, 0 fail`

- [ ] **Step 5: Write the walker integration test**

`ChainWalker.fetchCurrentBlockHeight()` calls `getBlockByHeight(undefined, false)`, so a `MockLedger` must return the tip block when `height` is `undefined`.

Create `tests/indexer/walker.integration.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block, UnconfirmedTransactionList } from "@signumjs/core";
import type { MockLedger } from "signum-chain-walker/dist/mockLedger";
import { ChainWalker } from "signum-chain-walker";
import { Amount, ChainTime } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { createBlockHandler } from "../../src/indexer/blockHandler.ts";

let db: Ledger;
let dir: string;

beforeEach(() => {
  db = openLedger(":memory:");
  dir = mkdtempSync(join(tmpdir(), "walker-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TIP = 1005;
const START = 1000;

const blockAt = (height: number): Block =>
  ({
    block: `block-${height}`,
    height,
    timestamp: ChainTime.fromDate(new Date("2026-03-14T12:00:00Z")).getChainTimestamp(),
    generator: "acct-1",
    generatorRS: "TS-XXXX",
    generatorPublicKey: "pk-acct-1",
    transactions: [],
  }) as unknown as Block;

const mockLedger: MockLedger = {
  block: {
    // height === undefined means "the current block", per fetchCurrentBlockHeight
    getBlockByHeight: async (height: number, _includeTransactions: boolean) =>
      blockAt(height === undefined ? TIP : height),
  },
  transaction: {
    getUnconfirmedTransactions: async () =>
      ({ unconfirmedTransactions: [] }) as unknown as UnconfirmedTransactionList,
  },
};

const walkOnce = async (cachePath: string) => {
  const handler = createBlockHandler({
    db,
    policy: {
      rewardPerBlock: Amount.fromSigna("2.5"),
      accountDailyCap: Amount.fromSigna("100"),
      globalDailyBudget: Amount.fromSigna("1000"),
    },
    lookupMainnetAccount: async () => ({ isActive: true, publicKey: "pk-acct-1" }),
    isExcluded: () => false,
  });

  const walker = new ChainWalker({
    nodeHost: "http://unused",
    mockLedger,
    cachePath,
    blockOffset: 0,
  }).onBlock(async (block) => {
    await handler(block);
  });

  await walker.walk(START);
};

describe("ChainWalker integration", () => {
  test("walking records the blocks it processes", async () => {
    await walkOnce(join(dir, "cache.json"));
    const rows = db.query("SELECT COUNT(*) AS c FROM block_rewards").get() as { c: number };
    expect(rows.c).toBeGreaterThan(0);
    const tip = db
      .query("SELECT COUNT(*) AS c FROM block_rewards WHERE block_id = ?1")
      .get(`block-${TIP}`) as { c: number };
    expect(tip.c).toBe(1);
  });

  test("RESTART SAFETY: walking again from scratch adds nothing", async () => {
    // A fresh cache file forces a full re-walk, simulating the worst case where
    // the walker cache is lost but the ledger survives.
    await walkOnce(join(dir, "cache-a.json"));
    const first = db.query("SELECT COUNT(*) AS c FROM block_rewards").get() as { c: number };

    await walkOnce(join(dir, "cache-b.json"));
    const second = db.query("SELECT COUNT(*) AS c FROM block_rewards").get() as { c: number };

    expect(second.c).toBe(first.c);
  });
}, 20_000);
```

- [ ] **Step 6: Run the integration test**

Run: `bun test tests/indexer/walker.integration.test.ts`
Expected: `2 pass, 0 fail`

If the first test reports 0 rows, the walker's start semantics differ from the assumption that it processes blocks *above* `START`. Adjust `START`/`TIP` until rows appear — the second test is the one that matters and it holds regardless.

- [ ] **Step 7: Wire the indexer**

Create `src/indexer/indexer.ts`:

```ts
import { ChainWalker } from "signum-chain-walker";
import type { Ledger } from "../ledger/db.ts";
import type { AppConfig } from "../config/schema.ts";
import type { MainnetAccountFacts } from "../eligibility/eligibility.ts";
import { createBlockHandler } from "./blockHandler.ts";

export interface IndexerDeps {
  db: Ledger;
  config: AppConfig;
  walkerCachePath: string;
  lookupMainnetAccount: (accountId: string) => Promise<MainnetAccountFacts | undefined>;
  isExcluded: (accountId: string) => boolean;
  onBlockObserved: (height: number) => void;
}

export interface Indexer {
  /** Catches up from the configured start height, then listens. Resolves only on stop. */
  run: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createIndexer(deps: IndexerDeps): Indexer {
  const handler = createBlockHandler({
    db: deps.db,
    policy: deps.config.policy,
    lookupMainnetAccount: deps.lookupMainnetAccount,
    isExcluded: deps.isExcluded,
  });

  const walker = new ChainWalker({
    nodeHost: deps.config.chain.testnetNodeHost,
    cachePath: deps.walkerCachePath,
    intervalSeconds: deps.config.chain.walkerIntervalSeconds,
    blockOffset: deps.config.chain.blockOffset,
  }).onBlock(async (block) => {
    await handler(block);
    deps.onBlockObserved(block.height);
  });

  return {
    async run() {
      // walk() resumes from the cached height when it exceeds startHeight, so a
      // restart continues where it left off rather than replaying everything.
      await walker.walk(deps.config.chain.startHeight);
      await walker.listen();
    },
    async stop() {
      await walker.stop();
    },
  };
}
```

- [ ] **Step 8: Typecheck and commit**

```bash
bunx tsc --noEmit
git add src/indexer tests/indexer
git commit -m "feat: add block handler and chain walker wiring"
```

---

## Task 13: Chain clients — testnet reads and mainnet failover pool

**Files:**
- Create: `src/chain/mainnetPool.ts`
- Create: `src/chain/testnetClient.ts`
- Test: `tests/chain/mainnetPool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/chain/mainnetPool.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { createMainnetPool, AllNodesFailedError } from "../../src/chain/mainnetPool.ts";
import type { MainnetNodeClient } from "../../src/chain/mainnetPool.ts";

/** A fake node that either answers or throws. */
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
    const account = await pool.getAccount("123");
    expect(account?.publicKey).toBe("pk-a");
  });

  test("FAILOVER: falls through to the next node when the first throws", async () => {
    const pool = createMainnetPool(["a", "b"], (host) =>
      host === "a" ? node({ fails: true }) : node({ publicKey: "pk-b" }),
    );
    const account = await pool.getAccount("123");
    expect(account?.publicKey).toBe("pk-b");
  });

  test("throws AllNodesFailedError only when every node fails", async () => {
    const pool = createMainnetPool(["a", "b"], () => node({ fails: true }));
    await expect(pool.getAccount("123")).rejects.toThrow(AllNodesFailedError);
  });

  test("STICKY: after a failover, later calls start from the node that worked", async () => {
    let aCalls = 0;
    const pool = createMainnetPool(["a", "b"], (host) => {
      if (host === "a") {
        return {
          getAccount: async () => {
            aCalls++;
            throw new Error("node down");
          },
        };
      }
      return node({ publicKey: "pk-b" });
    });
    await pool.getAccount("1");
    await pool.getAccount("2");
    await pool.getAccount("3");
    // 'a' is tried once, then skipped in favour of the known-good node.
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/chain/mainnetPool.test.ts`
Expected: FAIL — `Cannot find module '../../src/chain/mainnetPool.ts'`

- [ ] **Step 3: Implement**

Create `src/chain/mainnetPool.ts`:

```ts
import { LedgerClientFactory } from "@signumjs/core";

export interface MainnetAccountResult {
  account: string;
  publicKey: string | null;
  balanceNQT: string;
}

/** The narrow slice of a ledger client this pool needs. Injectable for tests. */
export interface MainnetNodeClient {
  getAccount: (accountId: string) => Promise<MainnetAccountResult>;
}

export class AllNodesFailedError extends Error {
  constructor(hosts: string[], lastError: unknown) {
    super(`All mainnet nodes failed (${hosts.join(", ")}): ${String(lastError)}`);
    this.name = "AllNodesFailedError";
  }
}

export interface MainnetPool {
  /** Returns undefined when the account does not exist on mainnet. */
  getAccount: (accountId: string) => Promise<MainnetAccountResult | undefined>;
}

/**
 * A node error carrying an errorCode means the node answered and said "no such
 * account". That is a real answer, not a node failure, so it must not trigger
 * failover: otherwise every lookup for an unregistered miner would walk the
 * whole pool and then throw.
 */
function isAccountNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "data" in e &&
    typeof (e as { data?: unknown }).data === "object" &&
    (e as { data?: { errorCode?: unknown } }).data?.errorCode !== undefined
  );
}

export function createMainnetPool(
  hosts: string[],
  makeClient: (host: string) => MainnetNodeClient = defaultClientFactory,
): MainnetPool {
  const clients = hosts.map(makeClient);
  // Index of the node that most recently worked; failover starts from here.
  let preferred = 0;

  async function withFailover<T>(fn: (client: MainnetNodeClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < clients.length; attempt++) {
      const index = (preferred + attempt) % clients.length;
      const client = clients[index];
      if (!client) continue;
      try {
        const result = await fn(client);
        preferred = index;
        return result;
      } catch (e) {
        if (isAccountNotFound(e)) {
          preferred = index;
          throw e;
        }
        lastError = e;
      }
    }
    throw new AllNodesFailedError(hosts, lastError);
  }

  return {
    async getAccount(accountId: string) {
      try {
        return await withFailover((c) => c.getAccount(accountId));
      } catch (e) {
        if (isAccountNotFound(e)) return undefined;
        throw e;
      }
    },
  };
}

function defaultClientFactory(host: string): MainnetNodeClient {
  const ledger = LedgerClientFactory.createClient({ nodeHost: host });
  return {
    getAccount: async (accountId: string) => {
      const account = await ledger.account.getAccount({ accountId });
      return {
        account: account.account,
        publicKey: account.publicKey || null,
        balanceNQT: account.balanceNQT,
      };
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/chain/mainnetPool.test.ts`
Expected: `5 pass, 0 fail`

- [ ] **Step 5: Add the testnet client**

Create `src/chain/testnetClient.ts`:

```ts
import { LedgerClientFactory } from "@signumjs/core";

export interface TestnetSnapshot {
  localHeight: number;
  globalHeight: number;
  isScanning: boolean;
  lastBlockId: string;
}

export interface TestnetClient {
  getSnapshot: () => Promise<TestnetSnapshot>;
  getPeerCount: () => Promise<number>;
}

/**
 * Read-only view of the local testnet node, used by the health monitor as the
 * HTTP fallback when the SIP-50 WebSocket heartbeat stops.
 *
 * BlockchainStatus.numberOfBlocks is the local height; lastBlockchainFeederHeight
 * is the height the network claims. Their difference is the sync lag.
 */
export function createTestnetClient(nodeHost: string): TestnetClient {
  const ledger = LedgerClientFactory.createClient({ nodeHost });
  return {
    async getSnapshot() {
      const status = await ledger.network.getBlockchainStatus();
      return {
        localHeight: status.numberOfBlocks,
        globalHeight: status.lastBlockchainFeederHeight,
        isScanning: status.isScanning,
        lastBlockId: status.lastBlock,
      };
    },
    async getPeerCount() {
      const peers = await ledger.network.getPeers();
      return peers.peers.length;
    },
  };
}
```

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

If `ledger.network.getBlockchainStatus` or `getPeers` are not on the `network` namespace in the installed `@signumjs/core`, find them with:

```bash
grep -rn "getBlockchainStatus\|getPeers" node_modules/@signumjs/core/out/typings/api/
```

and adjust the namespace accordingly.

- [ ] **Step 7: Commit**

```bash
git add src/chain tests/chain
git commit -m "feat: add mainnet failover pool and testnet read client"
```

---

## Task 14: Batch composition and dry-run

Composition is pure so the selection rules can be tested without a database. Dry-run is the safety feature that makes the first real payout non-terrifying.

**Files:**
- Create: `src/payout/compose.ts`
- Create: `src/payout/dryRun.ts`
- Test: `tests/payout/compose.test.ts`
- Test: `tests/payout/dryRun.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/payout/compose.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { Amount } from "@signumjs/util";
import { composeBatch, MAX_MULTI_OUT_RECIPIENTS } from "../../src/payout/compose.ts";
import type { UnpaidAggregate } from "../../src/ledger/batches.ts";

const agg = (recipientId: string, signa: string, oldestCreatedAt = 0): UnpaidAggregate => ({
  recipientId,
  amount: Amount.fromSigna(signa),
  accrualCount: 1,
  oldestCreatedAt,
});

const opts = { minPayout: Amount.fromSigna("5"), maxRecipients: MAX_MULTI_OUT_RECIPIENTS };

describe("composeBatch", () => {
  test("includes recipients at or above the dust threshold", () => {
    const result = composeBatch([agg("a", "5"), agg("b", "9")], opts);
    expect(result.draft.recipients).toHaveLength(2);
    expect(result.draft.total.getSigna()).toBe("14");
  });

  test("DUST ROLLS OVER: below-threshold recipients are deferred, not dropped", () => {
    const result = composeBatch([agg("a", "9"), agg("dusty", "0.1")], opts);
    expect(result.draft.recipients.map((r) => r.recipientId)).toEqual(["a"]);
    expect(result.deferredDust.map((r) => r.recipientId)).toEqual(["dusty"]);
  });

  test("FAIRNESS: orders by oldest accrual first, not by size", () => {
    const result = composeBatch([agg("newer-big", "90", 200), agg("older-small", "6", 100)], opts);
    expect(result.draft.recipients[0]?.recipientId).toBe("older-small");
  });

  test("caps at the node's multi-out limit and defers the remainder", () => {
    const many = Array.from({ length: 70 }, (_, i) => agg(`a${i}`, "6", i));
    const result = composeBatch(many, opts);
    expect(result.draft.recipients).toHaveLength(64);
    expect(result.deferredOverflow).toHaveLength(6);
  });

  test("the deferred overflow is the newest accruals, so the oldest are paid first", () => {
    const many = Array.from({ length: 66 }, (_, i) => agg(`a${i}`, "6", i));
    const result = composeBatch(many, opts);
    expect(result.deferredOverflow.map((r) => r.recipientId)).toEqual(["a64", "a65"]);
  });

  test("the total always equals the sum of included recipients", () => {
    const result = composeBatch([agg("a", "6"), agg("b", "7.5")], opts);
    expect(result.draft.total.getSigna()).toBe("13.5");
  });

  test("produces an empty draft when everything is dust", () => {
    const result = composeBatch([agg("a", "0.0001")], opts);
    expect(result.draft.recipients).toHaveLength(0);
    expect(result.draft.total.getPlanck()).toBe("0");
  });

  test("flags a single-recipient batch, which cannot use multi-out", () => {
    // signum-node's Attachment.java rejects recipients.size() <= 1.
    expect(composeBatch([agg("a", "6")], opts).requiresOrdinarySend).toBe(true);
  });

  test("does not flag ordinary-send for two or more recipients", () => {
    expect(composeBatch([agg("a", "6"), agg("b", "6")], opts).requiresOrdinarySend).toBe(false);
  });

  test("MUTATION SAFETY: composing does not modify the input aggregates", () => {
    const input = [agg("a", "6"), agg("b", "7")];
    composeBatch(input, opts);
    composeBatch(input, opts);
    expect(input[0]?.amount.getSigna()).toBe("6");
    expect(input[1]?.amount.getSigna()).toBe("7");
    expect(opts.minPayout.getSigna()).toBe("5");
  });
});
```

Create `tests/payout/dryRun.test.ts`:

```ts
import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { aggregateUnpaidByRecipient } from "../../src/ledger/batches.ts";
import { dryRunBatch } from "../../src/payout/dryRun.ts";
import type { RailsConfig } from "../../src/domain/rails.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

const rails: RailsConfig = {
  maxPerRecipientPerBatch: Amount.fromSigna("200"),
  maxPerBatch: Amount.fromSigna("2000"),
  maxPerWallClockDay: Amount.fromSigna("3000"),
};

const accrue = (blockId: string, generatorId: string, signa: string) =>
  recordBlockReward(db, {
    blockId,
    height: 1,
    blockTimestamp: 1,
    chainDay: "2026-03-14",
    generatorId,
    generatorPublicKey: "pk",
    status: "accrued",
    amount: Amount.fromSigna(signa),
  });

const opts = () => ({
  minPayout: Amount.fromSigna("5"),
  rails,
  spentToday: Amount.Zero(),
});

describe("dryRunBatch", () => {
  test("reports what would be sent without changing anything", () => {
    accrue("b1", "acct-1", "10");
    accrue("b2", "acct-2", "10");

    const beforeCount = aggregateUnpaidByRecipient(db).length;
    const report = dryRunBatch(db, opts());

    expect(report.wouldSend).toBe(true);
    expect(report.draft.recipients).toHaveLength(2);
    expect(report.draft.total.getSigna()).toBe("20");
    expect(report.railsVerdict).toEqual({ ok: true });

    // NOTHING was claimed: the unpaid pool is untouched and no batch exists.
    expect(aggregateUnpaidByRecipient(db)).toHaveLength(beforeCount);
    const batches = db.query("SELECT COUNT(*) AS c FROM batches").get() as { c: number };
    expect(batches.c).toBe(0);
  });

  test("reports a rail violation instead of a sendable batch", () => {
    accrue("b1", "acct-1", "500"); // over the per-recipient rail
    const report = dryRunBatch(db, opts());
    expect(report.wouldSend).toBe(false);
    expect(report.railsVerdict.ok).toBe(false);
  });

  test("reports nothing to send when the pool is empty", () => {
    const report = dryRunBatch(db, opts());
    expect(report.wouldSend).toBe(false);
    expect(report.draft.recipients).toHaveLength(0);
  });

  test("reports nothing to send when everything is below the dust threshold", () => {
    accrue("b1", "acct-1", "0.5");
    const report = dryRunBatch(db, opts());
    expect(report.wouldSend).toBe(false);
    expect(report.deferredDust).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/payout/`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement composition**

Create `src/payout/compose.ts`:

```ts
import type { Amount } from "@signumjs/util";
import type { BatchDraft, RecipientAmount } from "../domain/types.ts";
import type { UnpaidAggregate } from "../ledger/batches.ts";
import { sumAmounts } from "../domain/money.ts";

/** signum-node Constants.java: MAX_MULTI_OUT_RECIPIENTS = 64. */
export const MAX_MULTI_OUT_RECIPIENTS = 64;

export interface ComposeOptions {
  minPayout: Amount;
  maxRecipients: number;
}

export interface ComposeResult {
  draft: BatchDraft;
  /** Below the dust threshold; their accruals stay unbatched and roll over. */
  deferredDust: UnpaidAggregate[];
  /** Above the recipient limit; paid in a later batch, oldest first. */
  deferredOverflow: UnpaidAggregate[];
  /**
   * True when exactly one recipient qualifies. signum-node's Attachment.java
   * rejects multi-out with recipients.size() <= 1, so the caller must fall back
   * to an ordinary sendAmount. This is a normal path on quiet days.
   */
  requiresOrdinarySend: boolean;
}

/**
 * Selects who gets paid in the next batch.
 *
 * Ordering is oldest-accrual-first rather than largest-first: with a hard
 * recipient cap, size-ordering would let a steadily-mining large account
 * indefinitely starve smaller ones.
 *
 * Amounts are cloned into the draft so downstream arithmetic cannot mutate the
 * aggregates the caller still holds.
 */
export function composeBatch(aggregates: UnpaidAggregate[], opts: ComposeOptions): ComposeResult {
  const deferredDust: UnpaidAggregate[] = [];
  const eligible: UnpaidAggregate[] = [];

  for (const a of aggregates) {
    if (a.amount.less(opts.minPayout)) deferredDust.push(a);
    else eligible.push(a);
  }

  // Copy before sorting: Array.prototype.sort mutates in place, and the caller's
  // array should not be reordered as a side effect of composing.
  const ordered = [...eligible].sort((x, y) => x.oldestCreatedAt - y.oldestCreatedAt);

  const included = ordered.slice(0, opts.maxRecipients);
  const deferredOverflow = ordered.slice(opts.maxRecipients);

  const recipients: RecipientAmount[] = included.map((a) => ({
    recipientId: a.recipientId,
    amount: a.amount.clone(),
  }));

  return {
    draft: { recipients, total: sumAmounts(recipients.map((r) => r.amount)) },
    deferredDust,
    deferredOverflow,
    requiresOrdinarySend: recipients.length === 1,
  };
}
```

- [ ] **Step 4: Implement dry-run**

Create `src/payout/dryRun.ts`:

```ts
import type { Amount } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { RailsConfig, RailsVerdict } from "../domain/rails.ts";
import { checkRails } from "../domain/rails.ts";
import { aggregateUnpaidByRecipient } from "../ledger/batches.ts";
import { composeBatch, MAX_MULTI_OUT_RECIPIENTS } from "./compose.ts";
import type { ComposeResult } from "./compose.ts";

export interface DryRunOptions {
  minPayout: Amount;
  rails: RailsConfig;
  spentToday: Amount;
}

export interface DryRunReport extends ComposeResult {
  railsVerdict: RailsVerdict;
  wouldSend: boolean;
}

/**
 * Composes a batch and evaluates the rails WITHOUT claiming accruals, creating a
 * batch row, or touching the network.
 *
 * This is the pre-flight check before the first real payout: it shows exactly
 * who would receive what, and is safe to run at any time from the admin UI.
 */
export function dryRunBatch(db: Ledger, opts: DryRunOptions): DryRunReport {
  const composed = composeBatch(aggregateUnpaidByRecipient(db), {
    minPayout: opts.minPayout,
    maxRecipients: MAX_MULTI_OUT_RECIPIENTS,
  });

  if (composed.draft.recipients.length === 0) {
    return { ...composed, railsVerdict: { ok: true }, wouldSend: false };
  }

  const railsVerdict = checkRails(composed.draft, opts.rails, opts.spentToday);
  return { ...composed, railsVerdict, wouldSend: railsVerdict.ok };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/payout/`
Expected: `14 pass, 0 fail`

- [ ] **Step 6: Commit**

```bash
git add src/payout tests/payout
git commit -m "feat: add batch composition and non-mutating dry-run"
```

---


## Task 15: Health state machine (pure)

The whole point of this module is to keep "our observer is broken" distinguishable from "the testnet is stuck". Conflating them is the false alarm that trains an operator to ignore alerts.

**Files:**
- Create: `src/health/healthState.ts`
- Test: `tests/health/healthState.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/health/healthState.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { assessHealth } from "../../src/health/healthState.ts";
import type { HealthInputs, HealthThresholds } from "../../src/health/healthState.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const thresholds: HealthThresholds = {
  heartbeatTimeoutMs: 90_000, // ~3 missed 30s heartbeats
  stallThresholdMs: 15 * MIN,
  syncLagBlocks: 5,
  minPeers: 3,
};

const healthy: HealthInputs = {
  nowMs: NOW,
  lastHeartbeatAtMs: NOW - 10_000,
  lastBlockAtMs: NOW - 2 * MIN,
  httpReachable: true,
  localHeight: 1000,
  globalHeight: 1000,
  peerCount: 8,
};

const kinds = (i: HealthInputs) => assessHealth(i, thresholds).conditions.map((c) => c.kind);

describe("assessHealth", () => {
  test("reports ok when everything is healthy", () => {
    const result = assessHealth(healthy, thresholds);
    expect(result.overall).toBe("ok");
    expect(result.conditions).toHaveLength(0);
  });

  test("CRITICAL: heartbeat gone and HTTP unreachable means our side is broken", () => {
    const result = assessHealth(
      { ...healthy, lastHeartbeatAtMs: NOW - 5 * MIN, httpReachable: false },
      thresholds,
    );
    expect(result.overall).toBe("critical");
    expect(result.conditions.map((c) => c.kind)).toContain("node_unreachable");
  });

  test("CRITICAL: no blocks past the stall threshold means the testnet is stuck", () => {
    const result = assessHealth({ ...healthy, lastBlockAtMs: NOW - 20 * MIN }, thresholds);
    expect(result.overall).toBe("critical");
    expect(result.conditions.map((c) => c.kind)).toContain("testnet_stalled");
  });

  test("THE KEY CASE: dead socket but HTTP fine and blocks advancing is only a warning", () => {
    // Without the HTTP fallback this would be indistinguishable from a stall.
    const result = assessHealth(
      { ...healthy, lastHeartbeatAtMs: NOW - 5 * MIN, httpReachable: true },
      thresholds,
    );
    expect(result.overall).toBe("warning");
    expect(result.conditions.map((c) => c.kind)).toContain("ws_degraded");
    expect(result.conditions.map((c) => c.kind)).not.toContain("testnet_stalled");
  });

  test("a dead socket does not suppress a genuine stall detected over HTTP", () => {
    const result = assessHealth(
      {
        ...healthy,
        lastHeartbeatAtMs: NOW - 5 * MIN,
        httpReachable: true,
        lastBlockAtMs: NOW - 20 * MIN,
      },
      thresholds,
    );
    expect(result.conditions.map((c) => c.kind)).toContain("testnet_stalled");
    expect(result.overall).toBe("critical");
  });

  test("warns when the local node lags the network", () => {
    expect(kinds({ ...healthy, localHeight: 990, globalHeight: 1000 })).toContain(
      "node_out_of_sync",
    );
  });

  test("does not warn for a lag within tolerance", () => {
    expect(kinds({ ...healthy, localHeight: 997, globalHeight: 1000 })).not.toContain(
      "node_out_of_sync",
    );
  });

  test("warns on low peer count", () => {
    expect(kinds({ ...healthy, peerCount: 1 })).toContain("low_peers");
  });

  test("STARTUP: unknown block time is not treated as a stall", () => {
    // On a cold start we have not seen a block yet. Claiming the chain is stuck
    // would fire a critical alert every single restart.
    const result = assessHealth({ ...healthy, lastBlockAtMs: undefined }, thresholds);
    expect(result.conditions.map((c) => c.kind)).not.toContain("testnet_stalled");
  });

  test("STARTUP: unknown heights and peer count raise nothing", () => {
    const result = assessHealth(
      {
        nowMs: NOW,
        lastHeartbeatAtMs: NOW - 1000,
        lastBlockAtMs: undefined,
        httpReachable: true,
        localHeight: undefined,
        globalHeight: undefined,
        peerCount: undefined,
      },
      thresholds,
    );
    expect(result.overall).toBe("ok");
  });

  test("reports several simultaneous conditions, escalating to the worst", () => {
    const result = assessHealth(
      { ...healthy, peerCount: 1, lastBlockAtMs: NOW - 20 * MIN },
      thresholds,
    );
    expect(result.conditions.map((c) => c.kind).sort()).toEqual(["low_peers", "testnet_stalled"]);
    expect(result.overall).toBe("critical");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/health/healthState.test.ts`
Expected: FAIL — `Cannot find module '../../src/health/healthState.ts'`

- [ ] **Step 3: Implement**

Create `src/health/healthState.ts`:

```ts
import type { Severity } from "../ledger/alerts.ts";

export type HealthAlertKind =
  | "node_unreachable"
  | "testnet_stalled"
  | "ws_degraded"
  | "node_out_of_sync"
  | "low_peers";

export interface HealthInputs {
  nowMs: number;
  /** Last SIP-50 HEARTBEAT. undefined means we have never had one. */
  lastHeartbeatAtMs: number | undefined;
  /** Last observed new block, from either WS BLOCK_PUSHED or an HTTP height increase. */
  lastBlockAtMs: number | undefined;
  /** Whether the most recent HTTP probe of the testnet node succeeded. */
  httpReachable: boolean;
  localHeight: number | undefined;
  globalHeight: number | undefined;
  peerCount: number | undefined;
}

export interface HealthThresholds {
  heartbeatTimeoutMs: number;
  stallThresholdMs: number;
  syncLagBlocks: number;
  minPeers: number;
}

export interface HealthCondition {
  kind: HealthAlertKind;
  severity: Severity;
  message: string;
}

export interface HealthAssessment {
  overall: "ok" | "warning" | "critical";
  conditions: HealthCondition[];
  wsAlive: boolean;
}

/**
 * Turns raw observations into a set of active conditions.
 *
 * The design rule: never infer a chain problem from an observer problem. A dead
 * WebSocket alone is `ws_degraded`, a warning, because the HTTP fallback still
 * tells us whether blocks are advancing. Only when BOTH transports are silent do
 * we say the node is unreachable, and `testnet_stalled` is raised strictly from
 * block timing, whichever transport supplied it.
 *
 * Unknown inputs raise nothing. On a cold start we have not seen a block yet,
 * and treating that as a stall would fire a critical alert on every restart.
 */
export function assessHealth(
  inputs: HealthInputs,
  thresholds: HealthThresholds,
): HealthAssessment {
  const conditions: HealthCondition[] = [];

  const wsAlive =
    inputs.lastHeartbeatAtMs !== undefined &&
    inputs.nowMs - inputs.lastHeartbeatAtMs <= thresholds.heartbeatTimeoutMs;

  if (!wsAlive && !inputs.httpReachable) {
    conditions.push({
      kind: "node_unreachable",
      severity: "critical",
      message: "Testnet node is unreachable over both WebSocket and HTTP",
    });
  } else if (!wsAlive) {
    conditions.push({
      kind: "ws_degraded",
      severity: "warning",
      message: "SIP-50 heartbeat lost; falling back to HTTP polling. Chain status still known.",
    });
  }

  if (inputs.lastBlockAtMs !== undefined) {
    const sinceBlockMs = inputs.nowMs - inputs.lastBlockAtMs;
    if (sinceBlockMs > thresholds.stallThresholdMs) {
      conditions.push({
        kind: "testnet_stalled",
        severity: "critical",
        message: `No new block for ${Math.floor(sinceBlockMs / 60_000)} minutes`,
      });
    }
  }

  if (inputs.localHeight !== undefined && inputs.globalHeight !== undefined) {
    const lag = inputs.globalHeight - inputs.localHeight;
    if (lag > thresholds.syncLagBlocks) {
      conditions.push({
        kind: "node_out_of_sync",
        severity: "warning",
        message: `Local node is ${lag} blocks behind the network`,
      });
    }
  }

  if (inputs.peerCount !== undefined && inputs.peerCount < thresholds.minPeers) {
    conditions.push({
      kind: "low_peers",
      severity: "warning",
      message: `Only ${inputs.peerCount} peers connected (minimum ${thresholds.minPeers})`,
    });
  }

  const overall = conditions.some((c) => c.severity === "critical")
    ? "critical"
    : conditions.length > 0
      ? "warning"
      : "ok";

  return { overall, conditions, wsAlive };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/health/healthState.test.ts`
Expected: `11 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/health/healthState.ts tests/health/healthState.test.ts
git commit -m "feat: add health state machine distinguishing observer from chain failure"
```

---

## Task 16: SIP-50 WebSocket event reduction and the socket client

The event-folding logic is pure and tested; the socket itself is a thin wrapper verified in shadow mode. That split keeps reconnect plumbing out of the tests without leaving the interesting logic untested.

**Files:**
- Create: `src/health/wsEvents.ts`
- Create: `src/health/wsMonitor.ts`
- Test: `tests/health/wsEvents.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/health/wsEvents.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { initialWsState, reduceWsEvent, parseWsMessage } from "../../src/health/wsEvents.ts";

const NOW = 1_800_000_000_000;

describe("parseWsMessage", () => {
  test("parses a well-formed SIP-50 envelope", () => {
    expect(parseWsMessage('{"e":"HEARTBEAT"}')).toEqual({ e: "HEARTBEAT", p: undefined });
  });

  test("parses an envelope with a payload", () => {
    const msg = parseWsMessage('{"e":"BLOCK_PUSHED","p":{"height":1234}}');
    expect(msg?.e).toBe("BLOCK_PUSHED");
    expect(msg?.p).toEqual({ height: 1234 });
  });

  test("returns undefined for malformed JSON rather than throwing", () => {
    // A node sending garbage must not crash the health monitor.
    expect(parseWsMessage("not json")).toBeUndefined();
  });

  test("returns undefined when the event field is missing", () => {
    expect(parseWsMessage('{"p":{"height":1}}')).toBeUndefined();
  });

  test("ignores an unknown event type", () => {
    expect(parseWsMessage('{"e":"SOMETHING_NEW"}')).toBeUndefined();
  });
});

describe("reduceWsEvent", () => {
  test("HEARTBEAT records liveness without touching block state", () => {
    const state = reduceWsEvent(initialWsState(), { e: "HEARTBEAT" }, NOW);
    expect(state.lastHeartbeatAtMs).toBe(NOW);
    expect(state.lastBlockAtMs).toBeUndefined();
  });

  test("BLOCK_PUSHED records both a block and liveness", () => {
    // A block arriving is itself proof the socket is alive.
    const state = reduceWsEvent(initialWsState(), { e: "BLOCK_PUSHED", p: { height: 500 } }, NOW);
    expect(state.lastBlockAtMs).toBe(NOW);
    expect(state.lastHeartbeatAtMs).toBe(NOW);
    expect(state.localHeight).toBe(500);
  });

  test("CONNECTED records both heights for the sync-lag check", () => {
    const state = reduceWsEvent(
      initialWsState(),
      { e: "CONNECTED", p: { localHeight: 990, globalHeight: 1000 } },
      NOW,
    );
    expect(state.localHeight).toBe(990);
    expect(state.globalHeight).toBe(1000);
    expect(state.lastHeartbeatAtMs).toBe(NOW);
  });

  test("a BLOCK_PUSHED without a usable height still records the timing", () => {
    const state = reduceWsEvent(initialWsState(), { e: "BLOCK_PUSHED", p: {} }, NOW);
    expect(state.lastBlockAtMs).toBe(NOW);
    expect(state.localHeight).toBeUndefined();
  });

  test("PENDING_TRANSACTIONS_ADDED counts as liveness but not as a block", () => {
    const state = reduceWsEvent(initialWsState(), { e: "PENDING_TRANSACTIONS_ADDED" }, NOW);
    expect(state.lastHeartbeatAtMs).toBe(NOW);
    expect(state.lastBlockAtMs).toBeUndefined();
  });

  test("PURITY: reducing returns a new state and leaves the old one untouched", () => {
    const before = initialWsState();
    const after = reduceWsEvent(before, { e: "HEARTBEAT" }, NOW);
    expect(before.lastHeartbeatAtMs).toBeUndefined();
    expect(after).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/health/wsEvents.test.ts`
Expected: FAIL — `Cannot find module '../../src/health/wsEvents.ts'`

- [ ] **Step 3: Implement the pure reducer**

Create `src/health/wsEvents.ts`:

```ts
/**
 * SIP-50 event handling.
 *
 * Envelope: { e: "EVENT_NAME", p?: {...} }
 * Events:   CONNECTED, HEARTBEAT (~30s), BLOCK_PUSHED, PENDING_TRANSACTIONS_ADDED
 *
 * The spec limits this socket to reading public blockchain information, so it is
 * used only for liveness here and never touches the payout path.
 */
export type WsEventName =
  | "CONNECTED"
  | "HEARTBEAT"
  | "BLOCK_PUSHED"
  | "PENDING_TRANSACTIONS_ADDED";

const KNOWN_EVENTS: readonly WsEventName[] = [
  "CONNECTED",
  "HEARTBEAT",
  "BLOCK_PUSHED",
  "PENDING_TRANSACTIONS_ADDED",
];

export interface WsMessage {
  e: WsEventName;
  p?: Record<string, unknown>;
}

export interface WsState {
  lastHeartbeatAtMs: number | undefined;
  lastBlockAtMs: number | undefined;
  localHeight: number | undefined;
  globalHeight: number | undefined;
}

export function initialWsState(): WsState {
  return {
    lastHeartbeatAtMs: undefined,
    lastBlockAtMs: undefined,
    localHeight: undefined,
    globalHeight: undefined,
  };
}

/** Tolerant parse: a node sending garbage must never crash the health monitor. */
export function parseWsMessage(raw: string): WsMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const e = (parsed as { e?: unknown }).e;
  if (typeof e !== "string" || !KNOWN_EVENTS.includes(e as WsEventName)) return undefined;
  const p = (parsed as { p?: unknown }).p;
  return {
    e: e as WsEventName,
    p: typeof p === "object" && p !== null ? (p as Record<string, unknown>) : undefined,
  };
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/**
 * Folds one event into the liveness state.
 *
 * Every event refreshes the heartbeat timestamp, not just HEARTBEAT itself: any
 * message arriving is proof the socket is alive, and a busy node may debounce
 * heartbeats behind other traffic.
 */
export function reduceWsEvent(state: WsState, msg: WsMessage, nowMs: number): WsState {
  const next: WsState = { ...state, lastHeartbeatAtMs: nowMs };

  if (msg.e === "BLOCK_PUSHED") {
    next.lastBlockAtMs = nowMs;
    const height = num(msg.p?.height) ?? num(msg.p?.localHeight);
    if (height !== undefined) next.localHeight = height;
    const global = num(msg.p?.globalHeight);
    if (global !== undefined) next.globalHeight = global;
  }

  if (msg.e === "CONNECTED") {
    const local = num(msg.p?.localHeight);
    const global = num(msg.p?.globalHeight);
    if (local !== undefined) next.localHeight = local;
    if (global !== undefined) next.globalHeight = global;
  }

  return next;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/health/wsEvents.test.ts`
Expected: `12 pass, 0 fail`

- [ ] **Step 5: Implement the socket wrapper**

Create `src/health/wsMonitor.ts`:

```ts
import { initialWsState, parseWsMessage, reduceWsEvent } from "./wsEvents.ts";
import type { WsState } from "./wsEvents.ts";

export interface WsMonitor {
  start: () => void;
  stop: () => void;
  getState: () => WsState;
}

/**
 * Maintains a SIP-50 WebSocket connection and folds its events into liveness state.
 *
 * Reconnects with capped exponential backoff and never throws outward: the health
 * monitor treats a dead socket as a signal (ws_degraded), not as an error, and the
 * HTTP fallback covers the gap.
 */
export function createWsMonitor(url: string, now: () => number = Date.now): WsMonitor {
  let state = initialWsState();
  let socket: WebSocket | undefined;
  let retryMs = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const scheduleReconnect = () => {
    if (stopped) return;
    timer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  };

  const connect = () => {
    if (stopped) return;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      retryMs = 1_000;
    };
    socket.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const msg = parseWsMessage(raw);
      if (msg) state = reduceWsEvent(state, msg, now());
    };
    socket.onclose = () => scheduleReconnect();
    socket.onerror = () => socket?.close();
  };

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
    getState: () => state,
  };
}
```

- [ ] **Step 6: Typecheck and commit**

```bash
bunx tsc --noEmit
git add src/health/wsEvents.ts src/health/wsMonitor.ts tests/health/wsEvents.test.ts
git commit -m "feat: add SIP-50 event reduction and reconnecting websocket monitor"
```

---

## Task 17: Alert hysteresis and the health monitor loop

**Files:**
- Create: `src/health/hysteresis.ts`
- Create: `src/health/httpProbe.ts`
- Create: `src/health/monitor.ts`
- Test: `tests/health/hysteresis.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/health/hysteresis.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { emptyCounters, applyHysteresis } from "../../src/health/hysteresis.ts";
import type { HealthCondition } from "../../src/health/healthState.ts";

const opts = { openAfterChecks: 3, closeAfterChecks: 3 };

const lowPeers: HealthCondition = {
  kind: "low_peers",
  severity: "warning",
  message: "1 peer",
};

describe("applyHysteresis", () => {
  test("does not open an alert on the first sighting", () => {
    const result = applyHysteresis(emptyCounters(), [lowPeers], new Set(), opts);
    expect(result.toOpen).toHaveLength(0);
  });

  test("opens only after the condition holds for the required number of checks", () => {
    let counters = emptyCounters();
    let opened: HealthCondition[] = [];
    for (let i = 0; i < 3; i++) {
      const result = applyHysteresis(counters, [lowPeers], new Set(), opts);
      counters = result.counters;
      opened = result.toOpen;
    }
    expect(opened.map((c) => c.kind)).toEqual(["low_peers"]);
  });

  test("FLAPPING: an intermittent condition never opens", () => {
    // This is the scenario that would otherwise fill the operator's phone.
    let counters = emptyCounters();
    for (let i = 0; i < 20; i++) {
      const present = i % 2 === 0 ? [lowPeers] : [];
      const result = applyHysteresis(counters, present, new Set(), opts);
      counters = result.counters;
      expect(result.toOpen).toHaveLength(0);
    }
  });

  test("does not re-open an alert that is already open", () => {
    let counters = emptyCounters();
    for (let i = 0; i < 5; i++) {
      counters = applyHysteresis(counters, [lowPeers], new Set(["low_peers"]), opts).counters;
    }
    const result = applyHysteresis(counters, [lowPeers], new Set(["low_peers"]), opts);
    expect(result.toOpen).toHaveLength(0);
  });

  test("resolves only after the condition has cleared for the required checks", () => {
    let counters = emptyCounters();
    const open = new Set(["low_peers"]);
    let resolved: string[] = [];
    for (let i = 0; i < 2; i++) {
      const result = applyHysteresis(counters, [], open, opts);
      counters = result.counters;
      resolved = result.toResolve;
      expect(resolved).toHaveLength(0);
    }
    const final = applyHysteresis(counters, [], open, opts);
    expect(final.toResolve).toEqual(["low_peers"]);
  });

  test("does not resolve an alert that is not open", () => {
    let counters = emptyCounters();
    for (let i = 0; i < 5; i++) {
      const result = applyHysteresis(counters, [], new Set(), opts);
      counters = result.counters;
      expect(result.toResolve).toHaveLength(0);
    }
  });

  test("a reappearing condition resets the clear streak", () => {
    let counters = emptyCounters();
    const open = new Set(["low_peers"]);
    counters = applyHysteresis(counters, [], open, opts).counters;
    counters = applyHysteresis(counters, [], open, opts).counters;
    counters = applyHysteresis(counters, [lowPeers], open, opts).counters; // reappears
    const result = applyHysteresis(counters, [], open, opts);
    expect(result.toResolve).toHaveLength(0);
  });

  test("PURITY: the input counters are not mutated", () => {
    const before = emptyCounters();
    applyHysteresis(before, [lowPeers], new Set(), opts);
    expect(before.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/health/hysteresis.test.ts`
Expected: FAIL — `Cannot find module '../../src/health/hysteresis.ts'`

- [ ] **Step 3: Implement hysteresis**

Create `src/health/hysteresis.ts`:

```ts
import type { HealthCondition, HealthAlertKind } from "./healthState.ts";

export interface Streaks {
  present: number;
  absent: number;
}

export type HysteresisCounters = Map<string, Streaks>;

export function emptyCounters(): HysteresisCounters {
  return new Map();
}

export interface HysteresisOptions {
  openAfterChecks: number;
  closeAfterChecks: number;
}

export interface HysteresisResult {
  toOpen: HealthCondition[];
  toResolve: string[];
  counters: HysteresisCounters;
}

/**
 * Decides which alerts to open and resolve, requiring a condition to persist
 * before acting on it.
 *
 * The database's partial unique index already prevents duplicate open incidents;
 * this adds the second half of the protection by refusing to react to a
 * condition that has not held for several consecutive checks. Together they mean
 * a flapping signal produces no notifications at all rather than a stream.
 */
export function applyHysteresis(
  counters: HysteresisCounters,
  activeConditions: HealthCondition[],
  openKinds: Set<string>,
  opts: HysteresisOptions,
): HysteresisResult {
  const next: HysteresisCounters = new Map(counters);
  const activeByKind = new Map<HealthAlertKind, HealthCondition>();
  for (const c of activeConditions) activeByKind.set(c.kind, c);

  const allKinds = new Set<string>([...next.keys(), ...activeByKind.keys(), ...openKinds]);
  const toOpen: HealthCondition[] = [];
  const toResolve: string[] = [];

  for (const kind of allKinds) {
    const previous = next.get(kind) ?? { present: 0, absent: 0 };
    const condition = activeByKind.get(kind as HealthAlertKind);

    if (condition) {
      const streaks = { present: previous.present + 1, absent: 0 };
      next.set(kind, streaks);
      if (streaks.present >= opts.openAfterChecks && !openKinds.has(kind)) {
        toOpen.push(condition);
      }
    } else {
      const streaks = { present: 0, absent: previous.absent + 1 };
      next.set(kind, streaks);
      if (streaks.absent >= opts.closeAfterChecks && openKinds.has(kind)) {
        toResolve.push(kind);
      }
    }
  }

  return { toOpen, toResolve, counters: next };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test tests/health/hysteresis.test.ts`
Expected: `8 pass, 0 fail`

- [ ] **Step 5: Implement the HTTP probe**

Create `src/health/httpProbe.ts`:

```ts
import type { TestnetClient } from "../chain/testnetClient.ts";

export interface ProbeResult {
  httpReachable: boolean;
  localHeight: number | undefined;
  globalHeight: number | undefined;
  peerCount: number | undefined;
  /** Set when the height advanced since the previous probe. */
  blockAdvancedAtMs: number | undefined;
}

/**
 * Polls the testnet node over HTTP.
 *
 * This is what keeps `testnet_stalled` detectable when the SIP-50 socket is
 * dead: by tracking height changes between probes it supplies the block timing
 * the WebSocket would otherwise have provided.
 */
export function createHttpProbe(client: TestnetClient, now: () => number = Date.now) {
  let lastSeenHeight: number | undefined;

  return async function probe(): Promise<ProbeResult> {
    try {
      const snapshot = await client.getSnapshot();
      let blockAdvancedAtMs: number | undefined;
      if (lastSeenHeight !== undefined && snapshot.localHeight > lastSeenHeight) {
        blockAdvancedAtMs = now();
      }
      lastSeenHeight = snapshot.localHeight;

      let peerCount: number | undefined;
      try {
        peerCount = await client.getPeerCount();
      } catch {
        peerCount = undefined; // peers failing alone is not "node unreachable"
      }

      return {
        httpReachable: true,
        localHeight: snapshot.localHeight,
        globalHeight: snapshot.globalHeight,
        peerCount,
        blockAdvancedAtMs,
      };
    } catch {
      return {
        httpReachable: false,
        localHeight: undefined,
        globalHeight: undefined,
        peerCount: undefined,
        blockAdvancedAtMs: undefined,
      };
    }
  };
}
```

- [ ] **Step 6: Implement the monitor loop**

Create `src/health/monitor.ts`:

```ts
import type { Ledger } from "../ledger/db.ts";
import type { AppConfig } from "../config/schema.ts";
import type { WsMonitor } from "./wsMonitor.ts";
import type { ProbeResult } from "./httpProbe.ts";
import type { HealthAssessment } from "./healthState.ts";
import { assessHealth } from "./healthState.ts";
import { emptyCounters, applyHysteresis } from "./hysteresis.ts";
import type { HysteresisCounters } from "./hysteresis.ts";
import { openAlert, resolveAlert, listOpenAlerts } from "../ledger/alerts.ts";
import { recordHealthSample } from "../ledger/healthSamples.ts";

export interface HealthMonitorDeps {
  db: Ledger;
  config: AppConfig;
  wsMonitor: WsMonitor;
  probe: () => Promise<ProbeResult>;
  intervalMs: number;
  now?: () => number;
}

export interface HealthMonitor {
  start: () => void;
  stop: () => void;
  getLatest: () => HealthAssessment | undefined;
  /** Runs one cycle immediately. Exposed for the admin UI and for tests. */
  tick: () => Promise<HealthAssessment>;
}

export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const now = deps.now ?? Date.now;
  let counters: HysteresisCounters = emptyCounters();
  let latest: HealthAssessment | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastBlockAtMs: number | undefined;

  async function tick(): Promise<HealthAssessment> {
    const probeResult = await deps.probe();
    const wsState = deps.wsMonitor.getState();

    // Either transport observing a new block counts as block progress.
    if (wsState.lastBlockAtMs !== undefined) {
      lastBlockAtMs = Math.max(lastBlockAtMs ?? 0, wsState.lastBlockAtMs);
    }
    if (probeResult.blockAdvancedAtMs !== undefined) {
      lastBlockAtMs = Math.max(lastBlockAtMs ?? 0, probeResult.blockAdvancedAtMs);
    }

    const assessment = assessHealth(
      {
        nowMs: now(),
        lastHeartbeatAtMs: wsState.lastHeartbeatAtMs,
        lastBlockAtMs,
        httpReachable: probeResult.httpReachable,
        localHeight: probeResult.localHeight ?? wsState.localHeight,
        globalHeight: probeResult.globalHeight ?? wsState.globalHeight,
        peerCount: probeResult.peerCount,
      },
      {
        heartbeatTimeoutMs: 90_000,
        stallThresholdMs: deps.config.health.stallThresholdMinutes * 60_000,
        syncLagBlocks: deps.config.health.syncLagBlocks,
        minPeers: deps.config.health.minPeers,
      },
    );

    latest = assessment;

    const openKinds = new Set(listOpenAlerts(deps.db).map((a) => a.kind));
    const decision = applyHysteresis(counters, assessment.conditions, openKinds, {
      openAfterChecks: deps.config.health.alertOpenAfterChecks,
      closeAfterChecks: deps.config.health.alertCloseAfterChecks,
    });
    counters = decision.counters;

    for (const condition of decision.toOpen) {
      openAlert(deps.db, {
        kind: condition.kind,
        severity: condition.severity,
        message: condition.message,
      });
    }
    for (const kind of decision.toResolve) {
      resolveAlert(deps.db, kind);
    }

    recordHealthSample(deps.db, {
      sampledAt: Math.floor(now() / 1000),
      localHeight: probeResult.localHeight ?? null,
      globalHeight: probeResult.globalHeight ?? null,
      inSync: assessment.conditions.every((c) => c.kind !== "node_out_of_sync"),
      peerCount: probeResult.peerCount ?? null,
      secondsSinceLastBlock:
        lastBlockAtMs === undefined ? null : Math.floor((now() - lastBlockAtMs) / 1000),
      status: assessment.overall,
    });

    return assessment;
  }

  return {
    start() {
      deps.wsMonitor.start();
      void tick();
      timer = setInterval(() => void tick(), deps.intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      deps.wsMonitor.stop();
    },
    getLatest: () => latest,
    tick,
  };
}
```

- [ ] **Step 7: Add the health samples repository**

Create `src/ledger/healthSamples.ts`:

```ts
import type { Ledger } from "./db.ts";

export interface HealthSampleInput {
  sampledAt: number;
  localHeight: number | null;
  globalHeight: number | null;
  inSync: boolean;
  peerCount: number | null;
  secondsSinceLastBlock: number | null;
  status: string;
}

export function recordHealthSample(db: Ledger, sample: HealthSampleInput): void {
  db.query(
    `INSERT INTO health_samples
       (sampled_at, local_height, global_height, in_sync, peer_count,
        seconds_since_last_block, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(
    sample.sampledAt,
    sample.localHeight,
    sample.globalHeight,
    sample.inSync ? 1 : 0,
    sample.peerCount,
    sample.secondsSinceLastBlock,
    sample.status,
  );
}

/** Keeps the table bounded; the Pi's disk is not infinite and the page only charts recent history. */
export function pruneHealthSamples(db: Ledger, olderThanEpochSeconds: number): number {
  return db.query("DELETE FROM health_samples WHERE sampled_at < ?1").run(olderThanEpochSeconds)
    .changes;
}

export function recentHealthSamples(db: Ledger, limit: number) {
  return db
    .query(
      `SELECT sampled_at, local_height, global_height, in_sync, peer_count,
              seconds_since_last_block, status
         FROM health_samples ORDER BY sampled_at DESC LIMIT ?1`,
    )
    .all(limit);
}
```

- [ ] **Step 8: Typecheck and commit**

```bash
bunx tsc --noEmit
git add src/health src/ledger/healthSamples.ts tests/health
git commit -m "feat: add alert hysteresis, HTTP probe and health monitor loop"
```

---

## Task 18: Notification channels and fan-out

**Files:**
- Create: `src/notify/channel.ts`
- Create: `src/notify/telegram.ts`
- Create: `src/notify/discord.ts`
- Create: `src/notify/email.ts`
- Create: `src/notify/notifier.ts`
- Test: `tests/notify/notifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/notify/notifier.test.ts`:

```ts
import { test, expect, describe, beforeEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { openAlert, listUnnotifiedAlerts } from "../../src/ledger/alerts.ts";
import { createNotifier } from "../../src/notify/notifier.ts";
import type { Channel } from "../../src/notify/channel.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

const recorder = (name: string, opts: { fails?: boolean } = {}) => {
  const sent: string[] = [];
  const channel: Channel = {
    name,
    minSeverity: "warning",
    async send(message) {
      if (opts.fails) throw new Error(`${name} unavailable`);
      sent.push(message.title);
    },
  };
  return { channel, sent };
};

describe("notifier", () => {
  test("delivers a pending alert to every channel", async () => {
    const a = recorder("telegram");
    const b = recorder("discord");
    openAlert(db, { kind: "testnet_stalled", severity: "critical", message: "no blocks" });

    await createNotifier({ db, channels: [a.channel, b.channel] }).flush();

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);
  });

  test("marks an alert notified when at least one channel succeeds", async () => {
    const ok = recorder("discord");
    const broken = recorder("telegram", { fails: true });
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });

    await createNotifier({ db, channels: [broken.channel, ok.channel] }).flush();

    expect(ok.sent).toHaveLength(1);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);
  });

  test("OFFLINE RETRY: an alert stays queued when every channel fails", async () => {
    // The Pi losing internet must not lose the alert. It fires on reconnect.
    const broken = recorder("telegram", { fails: true });
    openAlert(db, { kind: "wallet_low", severity: "warning", message: "low" });

    const notifier = createNotifier({ db, channels: [broken.channel] });
    await notifier.flush();
    expect(listUnnotifiedAlerts(db)).toHaveLength(1);

    // Connectivity returns; a working channel drains the queue.
    const ok = recorder("telegram");
    await createNotifier({ db, channels: [ok.channel] }).flush();
    expect(ok.sent).toHaveLength(1);
    expect(listUnnotifiedAlerts(db)).toHaveLength(0);
  });

  test("does not resend an already-notified alert", async () => {
    const a = recorder("telegram");
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });
    const notifier = createNotifier({ db, channels: [a.channel] });
    await notifier.flush();
    await notifier.flush();
    expect(a.sent).toHaveLength(1);
  });

  test("SEVERITY ROUTING: a warning skips a critical-only channel", async () => {
    const criticalOnly = recorder("email");
    criticalOnly.channel.minSeverity = "critical";
    const everything = recorder("telegram");
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });

    await createNotifier({ db, channels: [criticalOnly.channel, everything.channel] }).flush();

    expect(criticalOnly.sent).toHaveLength(0);
    expect(everything.sent).toHaveLength(1);
  });

  test("a critical alert reaches a critical-only channel", async () => {
    const criticalOnly = recorder("email");
    criticalOnly.channel.minSeverity = "critical";
    openAlert(db, { kind: "testnet_stalled", severity: "critical", message: "stuck" });
    await createNotifier({ db, channels: [criticalOnly.channel] }).flush();
    expect(criticalOnly.sent).toHaveLength(1);
  });

  test("flushing with no channels configured leaves alerts queued", async () => {
    openAlert(db, { kind: "low_peers", severity: "warning", message: "1 peer" });
    await createNotifier({ db, channels: [] }).flush();
    expect(listUnnotifiedAlerts(db)).toHaveLength(1);
  });

  test("flushing an empty queue is harmless", async () => {
    const a = recorder("telegram");
    await createNotifier({ db, channels: [a.channel] }).flush();
    expect(a.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/notify/notifier.test.ts`
Expected: FAIL — `Cannot find module '../../src/notify/notifier.ts'`

- [ ] **Step 3: Define the channel interface**

Create `src/notify/channel.ts`:

```ts
import type { Severity } from "../ledger/alerts.ts";

export interface NotificationMessage {
  title: string;
  body: string;
  severity: Severity;
}

export interface Channel {
  name: string;
  /** 'warning' receives everything; 'critical' receives only critical alerts. */
  minSeverity: Severity;
  send: (message: NotificationMessage) => Promise<void>;
}

export function severityAllows(channelMin: Severity, messageSeverity: Severity): boolean {
  if (channelMin === "warning") return true;
  return messageSeverity === "critical";
}
```

- [ ] **Step 4: Implement the three channels**

Create `src/notify/telegram.ts`:

```ts
import type { Channel } from "./channel.ts";
import type { Severity } from "../ledger/alerts.ts";

export function createTelegramChannel(
  cfg: { botToken: string; chatId: string },
  minSeverity: Severity = "warning",
): Channel {
  return {
    name: "telegram",
    minSeverity,
    async send(message) {
      const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text: `*${message.title}*\n${message.body}`,
          parse_mode: "Markdown",
        }),
      });
      if (!res.ok) throw new Error(`Telegram responded ${res.status}`);
    },
  };
}
```

Create `src/notify/discord.ts`:

```ts
import type { Channel } from "./channel.ts";
import type { Severity } from "../ledger/alerts.ts";

export function createDiscordChannel(
  cfg: { webhookUrl: string },
  minSeverity: Severity = "warning",
): Channel {
  return {
    name: "discord",
    minSeverity,
    async send(message) {
      const res = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `**${message.title}**\n${message.body}` }),
      });
      if (!res.ok) throw new Error(`Discord responded ${res.status}`);
    },
  };
}
```

Create `src/notify/email.ts`:

```ts
import type { Channel } from "./channel.ts";
import type { Severity } from "../ledger/alerts.ts";

/**
 * Resend over HTTP rather than SMTP: no long-lived connections to babysit on a
 * Pi, and the same fetch shape as the other channels.
 */
export function createEmailChannel(
  cfg: { resendApiKey: string; to: string },
  minSeverity: Severity = "critical",
): Channel {
  return {
    name: "email",
    minSeverity,
    async send(message) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: "Signum Testnet Rewards <onboarding@resend.dev>",
          to: [cfg.to],
          subject: message.title,
          text: message.body,
        }),
      });
      if (!res.ok) throw new Error(`Resend responded ${res.status}`);
    },
  };
}
```

The `from` address must be a domain verified in your Resend account; `onboarding@resend.dev` works for testing on the free tier.

- [ ] **Step 5: Implement the notifier**

Create `src/notify/notifier.ts`:

```ts
import type { Ledger } from "../ledger/db.ts";
import type { Channel } from "./channel.ts";
import { severityAllows } from "./channel.ts";
import { listUnnotifiedAlerts, markAlertNotified } from "../ledger/alerts.ts";

export interface NotifierDeps {
  db: Ledger;
  channels: Channel[];
}

export interface Notifier {
  /** Delivers every alert not yet notified. Safe to call on a timer. */
  flush: () => Promise<void>;
}

/**
 * Fans alerts out to the configured channels.
 *
 * An alert is marked notified only if at least one channel accepted it, so a
 * total outage (the Pi offline) leaves it queued and it fires on reconnect
 * rather than being silently dropped. A channel throwing never propagates: one
 * broken webhook must not stop the others.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  return {
    async flush() {
      for (const alert of listUnnotifiedAlerts(deps.db)) {
        const message = {
          title: `[${alert.severity.toUpperCase()}] ${alert.kind}`,
          body: alert.message,
          severity: alert.severity,
        };

        const delivered: string[] = [];
        for (const channel of deps.channels) {
          if (!severityAllows(channel.minSeverity, alert.severity)) continue;
          try {
            await channel.send(message);
            delivered.push(channel.name);
          } catch {
            // Deliberately swallowed: try the remaining channels, and leave the
            // alert queued if none succeed.
          }
        }

        if (delivered.length > 0) {
          markAlertNotified(deps.db, alert.id, delivered);
        }
      }
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/notify/notifier.test.ts`
Expected: `8 pass, 0 fail`

- [ ] **Step 7: Commit**

```bash
git add src/notify tests/notify
git commit -m "feat: add notification channels with severity routing and offline retry"
```

---

## Task 19: Read-model projection and Turso publisher

The projection is a pure function over ledger state; both the publisher and the admin UI consume it, so a new stat is added in one place and appears in both.

**Files:**
- Create: `config/turso-schema.sql`
- Create: `src/publish/projection.ts`
- Create: `src/publish/tursoPublisher.ts`
- Test: `tests/publish/projection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/publish/projection.test.ts`:

```ts
import { test, expect, describe, beforeEach } from "bun:test";
import { Amount } from "@signumjs/util";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { recordBlockReward } from "../../src/ledger/blockRewards.ts";
import { buildProjection } from "../../src/publish/projection.ts";

let db: Ledger;
beforeEach(() => {
  db = openLedger(":memory:");
});

const accrue = (blockId: string, generatorId: string, signa: string, status = "accrued") =>
  recordBlockReward(db, {
    blockId,
    height: Number(blockId.replace(/\D/g, "")) || 1,
    blockTimestamp: 500_000,
    chainDay: "2026-03-14",
    generatorId,
    generatorPublicKey: `pk-${generatorId}`,
    status: status as "accrued",
    amount: Amount.fromSigna(signa),
  });

const opts = { nowEpochSeconds: 1_800_000_000, chainDay: "2026-03-14", recentPayoutLimit: 20 };

describe("buildProjection", () => {
  test("summarises miners with paid and pending split out", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-1", "2.5");
    accrue("b3", "acct-2", "2.5");

    const projection = buildProjection(db, opts);
    const miner = projection.miners.find((m) => m.accountId === "acct-1");
    expect(miner?.blocksMined).toBe(2);
    expect(miner?.pendingPlanck).toBe(500_000_000);
    expect(miner?.paidPlanck).toBe(0);
  });

  test("counts skipped blocks separately and records the reason", () => {
    accrue("b1", "acct-1", "2.5");
    accrue("b2", "acct-1", "0", "skipped_no_mainnet_account");

    const miner = buildProjection(db, opts).miners.find((m) => m.accountId === "acct-1");
    expect(miner?.blocksMined).toBe(1);
    expect(miner?.blocksSkipped).toBe(1);
    expect(miner?.lastSkipReason).toBe("skipped_no_mainnet_account");
  });

  test("reports today's remaining budget", () => {
    accrue("b1", "acct-1", "2.5");
    const projection = buildProjection(db, {
      ...opts,
      globalDailyBudget: Amount.fromSigna("1000"),
    });
    expect(projection.status.budgetRemainingPlanck).toBe(99_750_000_000);
  });

  test("STALENESS: the status carries the timestamp the page checks", () => {
    // Without this the page cannot tell a dead Pi from a healthy one.
    const projection = buildProjection(db, opts);
    expect(projection.status.updatedAt).toBe(opts.nowEpochSeconds);
  });

  test("amounts are emitted as planck integers, safe for JSON and SQL", () => {
    accrue("b1", "acct-1", "2.5");
    const miner = buildProjection(db, opts).miners.find((m) => m.accountId === "acct-1");
    expect(Number.isInteger(miner?.pendingPlanck)).toBe(true);
  });

  test("produces an empty but well-formed projection on a fresh ledger", () => {
    const projection = buildProjection(db, opts);
    expect(projection.miners).toEqual([]);
    expect(projection.payouts).toEqual([]);
    expect(projection.status.totalDistributedPlanck).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/publish/projection.test.ts`
Expected: FAIL — `Cannot find module '../../src/publish/projection.ts'`

- [ ] **Step 3: Write the Turso schema**

Create `config/turso-schema.sql`:

```sql
-- Public read-model. Disposable: rebuildable at any time from the Pi's ledger.
-- Contains no secrets and no internal error detail.

CREATE TABLE IF NOT EXISTS status (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at               INTEGER NOT NULL,
  service_status           TEXT    NOT NULL,
  payouts_enabled          INTEGER NOT NULL,
  payouts_paused           INTEGER NOT NULL,
  kill_switch              INTEGER NOT NULL,
  testnet_height           INTEGER,
  seconds_since_last_block INTEGER,
  peer_count               INTEGER,
  reward_per_block_planck  INTEGER,
  budget_remaining_planck  INTEGER,
  total_distributed_planck INTEGER,
  distributed_24h_planck   INTEGER,
  next_payout_at           INTEGER,
  open_alerts              TEXT
);

CREATE TABLE IF NOT EXISTS miners (
  account_id       TEXT PRIMARY KEY,
  address          TEXT,
  blocks_mined     INTEGER NOT NULL,
  blocks_skipped   INTEGER NOT NULL,
  pending_planck   INTEGER NOT NULL,
  paid_planck      INTEGER NOT NULL,
  last_block_at    INTEGER,
  last_skip_reason TEXT,
  cap_reached      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payouts (
  batch_id        INTEGER PRIMARY KEY,
  tx_id           TEXT,
  confirmed_at    INTEGER,
  recipient_count INTEGER,
  total_planck    INTEGER
);

CREATE TABLE IF NOT EXISTS payout_recipients (
  batch_id      INTEGER NOT NULL,
  recipient_id  TEXT    NOT NULL,
  amount_planck INTEGER NOT NULL,
  PRIMARY KEY (batch_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS health_history (
  sampled_at               INTEGER PRIMARY KEY,
  status                   TEXT,
  peer_count               INTEGER,
  seconds_since_last_block INTEGER
);
```

- [ ] **Step 4: Implement the projection**

Create `src/publish/projection.ts`:

```ts
import { Amount } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { BlockRewardStatus, ChainDay } from "../domain/types.ts";
import { toPlanckInt } from "../domain/money.ts";
import { sumAccruedGlobalOnDay } from "../ledger/blockRewards.ts";
import { listRecentBatches } from "../ledger/batches.ts";
import { listOpenAlerts } from "../ledger/alerts.ts";
import { isPayoutsPaused, isKillSwitchTripped } from "../ledger/state.ts";

export interface MinerRow {
  accountId: string;
  blocksMined: number;
  blocksSkipped: number;
  pendingPlanck: number;
  paidPlanck: number;
  lastBlockAt: number | null;
  lastSkipReason: BlockRewardStatus | null;
}

export interface StatusRow {
  updatedAt: number;
  payoutsPaused: boolean;
  killSwitch: boolean;
  budgetRemainingPlanck: number;
  totalDistributedPlanck: number;
  openAlerts: string[];
}

export interface PayoutRow {
  batchId: number;
  txId: string | null;
  confirmedAt: number | null;
  recipientCount: number | null;
  totalPlanck: number | null;
}

export interface Projection {
  status: StatusRow;
  miners: MinerRow[];
  payouts: PayoutRow[];
}

export interface ProjectionOptions {
  nowEpochSeconds: number;
  chainDay: ChainDay;
  recentPayoutLimit: number;
  globalDailyBudget?: Amount;
}

/**
 * Builds the public read-model from ledger state.
 *
 * Amounts leave as planck integers rather than Amount objects: this crosses a
 * JSON and SQL boundary, and an exact integer survives both without a
 * serialisation contract.
 *
 * Consumed by BOTH the Turso publisher and the admin UI, so a new statistic is
 * added once and appears on both surfaces.
 */
export function buildProjection(db: Ledger, opts: ProjectionOptions): Projection {
  const minerRows = db
    .query(
      `SELECT generator_id AS accountId,
              SUM(CASE WHEN status = 'accrued' THEN 1 ELSE 0 END)                              AS blocksMined,
              SUM(CASE WHEN status <> 'accrued' THEN 1 ELSE 0 END)                             AS blocksSkipped,
              COALESCE(SUM(CASE WHEN status = 'accrued' AND batch_id IS NULL
                                THEN amount_planck ELSE 0 END), 0)                             AS pendingPlanck,
              COALESCE(SUM(CASE WHEN status = 'accrued' AND batch_id IS NOT NULL
                                THEN amount_planck ELSE 0 END), 0)                             AS paidPlanck,
              MAX(block_timestamp)                                                             AS lastBlockAt
         FROM block_rewards
        GROUP BY generator_id`,
    )
    .all() as Omit<MinerRow, "lastSkipReason">[];

  const skipStmt = db.query(
    `SELECT status FROM block_rewards
      WHERE generator_id = ?1 AND status <> 'accrued'
      ORDER BY height DESC LIMIT 1`,
  );

  const miners: MinerRow[] = minerRows.map((m) => {
    const skip = skipStmt.get(m.accountId) as { status: BlockRewardStatus } | null;
    return { ...m, lastSkipReason: skip?.status ?? null };
  });

  const totalDistributedPlanck = (
    db
      .query(
        `SELECT COALESCE(SUM(amount_planck), 0) AS total
           FROM block_rewards WHERE status = 'accrued' AND batch_id IS NOT NULL`,
      )
      .get() as { total: number }
  ).total;

  const spentToday = sumAccruedGlobalOnDay(db, opts.chainDay);
  const budgetRemainingPlanck = opts.globalDailyBudget
    ? toPlanckInt(opts.globalDailyBudget.clone().subtract(spentToday))
    : 0;

  const payouts: PayoutRow[] = listRecentBatches(db, opts.recentPayoutLimit)
    .filter((b) => b.status === "confirmed")
    .map((b) => ({
      batchId: b.id,
      txId: b.txId,
      confirmedAt: null,
      recipientCount: b.recipientCount,
      totalPlanck: b.total ? toPlanckInt(b.total) : null,
    }));

  return {
    status: {
      updatedAt: opts.nowEpochSeconds,
      payoutsPaused: isPayoutsPaused(db),
      killSwitch: isKillSwitchTripped(db),
      budgetRemainingPlanck,
      totalDistributedPlanck,
      openAlerts: listOpenAlerts(db).map((a) => a.kind),
    },
    miners,
    payouts,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/publish/projection.test.ts`
Expected: `6 pass, 0 fail`

- [ ] **Step 6: Implement the publisher**

Create `src/publish/tursoPublisher.ts`:

```ts
import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import type { Projection } from "./projection.ts";

export interface Publisher {
  publish: (projection: Projection) => Promise<void>;
  close: () => void;
}

/**
 * Pushes the read-model to Turso.
 *
 * Deliberately stateless: `status` and `miners` are upserted from current state
 * every tick, so a failed push needs no queue — the next tick simply republishes
 * the truth. That is why the local ledger stays authoritative and this database
 * can be dropped and rebuilt at any time.
 */
export function createTursoPublisher(cfg: { url: string; authToken: string }): Publisher {
  const client: Client = createClient({ url: cfg.url, authToken: cfg.authToken });

  return {
    async publish(projection) {
      const statements = [
        {
          sql: `INSERT INTO status (id, updated_at, service_status, payouts_enabled,
                                    payouts_paused, kill_switch, budget_remaining_planck,
                                    total_distributed_planck, open_alerts)
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  updated_at               = excluded.updated_at,
                  service_status           = excluded.service_status,
                  payouts_enabled          = excluded.payouts_enabled,
                  payouts_paused           = excluded.payouts_paused,
                  kill_switch              = excluded.kill_switch,
                  budget_remaining_planck  = excluded.budget_remaining_planck,
                  total_distributed_planck = excluded.total_distributed_planck,
                  open_alerts              = excluded.open_alerts`,
          args: [
            projection.status.updatedAt,
            projection.status.openAlerts.length === 0 ? "ok" : "degraded",
            1,
            projection.status.payoutsPaused ? 1 : 0,
            projection.status.killSwitch ? 1 : 0,
            projection.status.budgetRemainingPlanck,
            projection.status.totalDistributedPlanck,
            JSON.stringify(projection.status.openAlerts),
          ],
        },
        ...projection.miners.map((m) => ({
          sql: `INSERT INTO miners (account_id, blocks_mined, blocks_skipped,
                                    pending_planck, paid_planck, last_block_at, last_skip_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(account_id) DO UPDATE SET
                  blocks_mined     = excluded.blocks_mined,
                  blocks_skipped   = excluded.blocks_skipped,
                  pending_planck   = excluded.pending_planck,
                  paid_planck      = excluded.paid_planck,
                  last_block_at    = excluded.last_block_at,
                  last_skip_reason = excluded.last_skip_reason`,
          args: [
            m.accountId,
            m.blocksMined,
            m.blocksSkipped,
            m.pendingPlanck,
            m.paidPlanck,
            m.lastBlockAt,
            m.lastSkipReason,
          ],
        })),
        ...projection.payouts.map((p) => ({
          sql: `INSERT INTO payouts (batch_id, tx_id, confirmed_at, recipient_count, total_planck)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(batch_id) DO UPDATE SET
                  tx_id           = excluded.tx_id,
                  confirmed_at    = excluded.confirmed_at,
                  recipient_count = excluded.recipient_count,
                  total_planck    = excluded.total_planck`,
          args: [p.batchId, p.txId, p.confirmedAt, p.recipientCount, p.totalPlanck],
        })),
      ];

      await client.batch(statements, "write");
    },
    close() {
      client.close();
    },
  };
}
```

- [ ] **Step 7: Commit**

```bash
git add src/publish config/turso-schema.sql tests/publish
git commit -m "feat: add read-model projection and stateless Turso publisher"
```

---

## Task 20: Admin UI — design system foundation and LAN server

Now that this repo is GPL-3.0-or-later, the design system from `signum-node`'s `feat/new-web-ui` branch can be reused directly. The token file is the shared artifact: five themes (`nexus`, `solaris`, `dawn`, `terminal`, `aurora`), each defining an identical set of CSS variables, so components style against `var(--panel)`, `var(--blue2)` and friends and theme correctly in all five.

**Files:**
- Create: `src/ui/theme.css`
- Create: `src/ui/components/{Card,Badge,SignaAmount}.tsx`
- Create: `src/admin/index.html`
- Create: `src/admin/app.tsx`
- Create: `src/admin/server.ts`
- Create: `bunfig.toml`
- Test: `tests/admin/server.test.ts`

- [ ] **Step 1: Install UI dependencies**

```bash
bun add react react-dom framer-motion
bun add -d @types/react @types/react-dom tailwindcss bun-plugin-tailwind
```

- [ ] **Step 2: Copy the theme tokens**

```bash
cd /Users/oliverhager/Code/signum/signum-node
git show feat/new-web-ui:web/src/index.css > /Users/oliverhager/Code/signum/signum-testnet-rewards/src/ui/theme.css
cd /Users/oliverhager/Code/signum/signum-testnet-rewards
head -30 src/ui/theme.css
```

Expected: the file starts with `@import "tailwindcss";` followed by the `:root, [data-theme="nexus"]` token block.

Add a provenance header at the top of `src/ui/theme.css`, immediately after the `@import` line:

```css
/*
 * Theme tokens from signum-node (GPL-3.0), branch feat/new-web-ui,
 * web/src/index.css. Reused here under the same licence.
 *
 * Every theme defines the SAME variable contract. Components must consume
 * var(--token) only and never hard-code a colour, or they will break when the
 * theme changes.
 */
```

- [ ] **Step 3: Configure the Tailwind plugin for Bun**

Create `bunfig.toml`:

```toml
[serve.static]
plugins = ["bun-plugin-tailwind"]
```

- [ ] **Step 4: Write the failing server test**

Create `tests/admin/server.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { openLedger } from "../../src/ledger/db.ts";
import type { Ledger } from "../../src/ledger/db.ts";
import { createAdminServer } from "../../src/admin/server.ts";
import type { AdminServer } from "../../src/admin/server.ts";
import { isPayoutsPaused, isKillSwitchTripped, tripKillSwitch } from "../../src/ledger/state.ts";
import { Amount } from "@signumjs/util";

let db: Ledger;
let server: AdminServer;
let base: string;
const TOKEN = "test-token";

beforeEach(() => {
  db = openLedger(":memory:");
  server = createAdminServer({
    db,
    token: TOKEN,
    host: "127.0.0.1",
    port: 0, // ephemeral
    minPayout: Amount.fromSigna("5"),
    rails: {
      maxPerRecipientPerBatch: Amount.fromSigna("200"),
      maxPerBatch: Amount.fromSigna("2000"),
      maxPerWallClockDay: Amount.fromSigna("3000"),
    },
    globalDailyBudget: Amount.fromSigna("1000"),
    getHealth: () => undefined,
  });
  base = server.url;
});
afterEach(() => server.stop());

const auth = { headers: { "x-admin-token": TOKEN } };

describe("admin server auth", () => {
  test("rejects an API request with no token", async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(401);
  });

  test("rejects an API request with a wrong token", async () => {
    const res = await fetch(`${base}/api/state`, { headers: { "x-admin-token": "nope" } });
    expect(res.status).toBe(401);
  });

  test("accepts a request with the correct token", async () => {
    const res = await fetch(`${base}/api/state`, auth);
    expect(res.status).toBe(200);
  });
});

describe("admin server routes", () => {
  test("GET /api/state returns the projection, health and a dry-run", async () => {
    const body = (await (await fetch(`${base}/api/state`, auth)).json()) as Record<string, unknown>;
    expect(body).toHaveProperty("projection");
    expect(body).toHaveProperty("dryRun");
    expect(body).toHaveProperty("openAlerts");
  });

  test("POST /api/pause and /api/resume toggle payouts", async () => {
    await fetch(`${base}/api/pause`, { method: "POST", ...auth });
    expect(isPayoutsPaused(db)).toBe(true);
    await fetch(`${base}/api/resume`, { method: "POST", ...auth });
    expect(isPayoutsPaused(db)).toBe(false);
  });

  test("POST /api/kill-switch/clear clears a tripped kill switch", async () => {
    tripKillSwitch(db, "test trip");
    expect(isKillSwitchTripped(db)).toBe(true);
    const res = await fetch(`${base}/api/kill-switch/clear`, { method: "POST", ...auth });
    expect(res.status).toBe(200);
    expect(isKillSwitchTripped(db)).toBe(false);
  });

  test("DRY RUN IS READ-ONLY: requesting it creates no batch", async () => {
    await fetch(`${base}/api/dry-run`, auth);
    const batches = db.query("SELECT COUNT(*) AS c FROM batches").get() as { c: number };
    expect(batches.c).toBe(0);
  });

  test("mutating routes reject GET", async () => {
    const res = await fetch(`${base}/api/pause`, auth);
    expect(res.status).toBe(405);
  });

  test("an unknown API route returns 404", async () => {
    const res = await fetch(`${base}/api/nonsense`, auth);
    expect(res.status).toBe(404);
  });

  test("the admin token never appears in a response body", async () => {
    const text = await (await fetch(`${base}/api/state`, auth)).text();
    expect(text).not.toContain(TOKEN);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `bun test tests/admin/server.test.ts`
Expected: FAIL — `Cannot find module '../../src/admin/server.ts'`

- [ ] **Step 6: Implement the server**

Create `src/admin/server.ts`:

```ts
import type { Amount } from "@signumjs/util";
import type { Ledger } from "../ledger/db.ts";
import type { RailsConfig } from "../domain/rails.ts";
import type { HealthAssessment } from "../health/healthState.ts";
import { buildProjection } from "../publish/projection.ts";
import { dryRunBatch } from "../payout/dryRun.ts";
import { toChainDay } from "../domain/chainDay.ts";
import { ChainTime } from "@signumjs/util";
import { listOpenAlerts } from "../ledger/alerts.ts";
import { setPayoutsPaused, clearKillSwitch, getKillSwitchReason } from "../ledger/state.ts";
import { sumBroadcastSinceWallClock } from "../ledger/batches.ts";

export interface AdminServerDeps {
  db: Ledger;
  token: string;
  host: string;
  port: number;
  minPayout: Amount;
  rails: RailsConfig;
  globalDailyBudget: Amount;
  getHealth: () => HealthAssessment | undefined;
}

export interface AdminServer {
  url: string;
  stop: () => void;
}

/** Length-independent comparison so the token cannot be probed by timing. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export function createAdminServer(deps: AdminServerDeps): AdminServer {
  const startOfWallClockDay = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };

  const currentDryRun = () =>
    dryRunBatch(deps.db, {
      minPayout: deps.minPayout,
      rails: deps.rails,
      spentToday: sumBroadcastSinceWallClock(deps.db, startOfWallClockDay()),
    });

  const server = Bun.serve({
    hostname: deps.host,
    port: deps.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (!url.pathname.startsWith("/api/")) {
        return new Response(Bun.file(new URL("./index.html", import.meta.url).pathname), {
          headers: { "content-type": "text/html" },
        });
      }

      const supplied = req.headers.get("x-admin-token") ?? url.searchParams.get("token") ?? "";
      if (!tokensMatch(supplied, deps.token)) {
        return json({ error: "unauthorized" }, 401);
      }

      const requirePost = () => req.method === "POST";

      switch (url.pathname) {
        case "/api/state": {
          const nowSeconds = Math.floor(Date.now() / 1000);
          return json({
            projection: buildProjection(deps.db, {
              nowEpochSeconds: nowSeconds,
              chainDay: toChainDay(ChainTime.fromDate(new Date()).getChainTimestamp()),
              recentPayoutLimit: 20,
              globalDailyBudget: deps.globalDailyBudget,
            }),
            health: deps.getHealth() ?? null,
            openAlerts: listOpenAlerts(deps.db),
            killSwitchReason: getKillSwitchReason(deps.db) ?? null,
            dryRun: serialiseDryRun(currentDryRun()),
          });
        }
        case "/api/dry-run":
          return json(serialiseDryRun(currentDryRun()));
        case "/api/pause":
          if (!requirePost()) return json({ error: "method not allowed" }, 405);
          setPayoutsPaused(deps.db, true);
          return json({ ok: true, paused: true });
        case "/api/resume":
          if (!requirePost()) return json({ error: "method not allowed" }, 405);
          setPayoutsPaused(deps.db, false);
          return json({ ok: true, paused: false });
        case "/api/kill-switch/clear":
          if (!requirePost()) return json({ error: "method not allowed" }, 405);
          clearKillSwitch(deps.db);
          return json({ ok: true });
        default:
          return json({ error: "not found" }, 404);
      }
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
  };
}

/** Amounts become planck integers so the response is plain JSON. */
function serialiseDryRun(report: ReturnType<typeof dryRunBatch>) {
  return {
    wouldSend: report.wouldSend,
    requiresOrdinarySend: report.requiresOrdinarySend,
    railsVerdict: report.railsVerdict,
    totalPlanck: report.draft.total.getPlanck(),
    recipients: report.draft.recipients.map((r) => ({
      recipientId: r.recipientId,
      planck: r.amount.getPlanck(),
    })),
    deferredDust: report.deferredDust.map((d) => d.recipientId),
    deferredOverflow: report.deferredOverflow.map((d) => d.recipientId),
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test tests/admin/server.test.ts`
Expected: `11 pass, 0 fail`

- [ ] **Step 8: Port the shared UI components**

Create `src/ui/components/Card.tsx` — adapted from `signum-node` `web/src/components/ui/Card.tsx` (GPL-3.0), with the `@/lib/utils` `cn` dependency replaced by a local helper:

```tsx
import { motion, type HTMLMotionProps } from "framer-motion";

const SPRING = { type: "spring" as const, stiffness: 300, damping: 20 };

const cn = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

interface CardProps extends Omit<HTMLMotionProps<"div">, "children"> {
  padding?: boolean;
  interactive?: boolean;
  children?: React.ReactNode;
}

export function Card({ children, className, padding = true, interactive = false, ...props }: CardProps) {
  return (
    <motion.div
      className={cn("relative backdrop-blur-[8px]", padding && "p-5", className)}
      style={{ background: "var(--panel)", border: "1px solid var(--border)", ...props.style }}
      whileHover={interactive ? { y: -2, boxShadow: "var(--card-hover)" } : undefined}
      transition={SPRING}
      {...props}
    >
      {/* Tactical accent: top-left and bottom-right only */}
      <div className="pointer-events-none absolute -left-px -top-px h-[14px] w-[14px] border-l-2 border-t-2 border-[var(--blue2)]" />
      <div className="pointer-events-none absolute -bottom-px -right-px h-[14px] w-[14px] border-b-2 border-r-2 border-[var(--blue2)]" />
      {children}
    </motion.div>
  );
}

export function CardLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("mb-2.5 text-[9px] font-semibold uppercase tracking-[3px] text-[var(--blue2)]", className)}>
      {children}
    </p>
  );
}

export function CardSub({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("mt-1.5 text-[10px] tracking-[1px] text-[var(--muted)]", className)}>{children}</p>;
}
```

Create `src/ui/components/SignaAmount.tsx` — takes planck (what the API returns) and renders the fractional part smaller, matching the node UI:

```tsx
const cn = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

const PLANCK_PER_SIGNA = 100_000_000n;

/** Formats a planck value. Input is a string because it crosses a JSON boundary. */
export function SignaAmount({
  planck,
  decimals = 2,
  className,
}: {
  planck: string;
  decimals?: number;
  className?: string;
}) {
  const value = BigInt(planck);
  const whole = value / PLANCK_PER_SIGNA;
  const frac = (value % PLANCK_PER_SIGNA).toString().padStart(8, "0").slice(0, decimals);
  return (
    <span className={cn("tabular-nums", className)}>
      {new Intl.NumberFormat().format(whole)}
      <span style={{ fontSize: "0.65em", opacity: 0.6 }}>.{frac}</span>
    </span>
  );
}
```

Create `src/ui/components/Badge.tsx`:

```tsx
type Tone = "ok" | "warn" | "crit" | "muted";

const TONE: Record<Tone, string> = {
  ok: "var(--green)",
  warn: "var(--amber)",
  crit: "var(--mag)",
  muted: "var(--muted)",
};

export function Badge({ tone = "muted", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className="inline-block px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[2px]"
      style={{ color: TONE[tone], border: `1px solid ${TONE[tone]}` }}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 9: Build the admin page**

Create `src/admin/index.html`:

```html
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signum Testnet Rewards — Admin</title>
    <link rel="stylesheet" href="../ui/theme.css" />
  </head>
  <body data-theme="nexus">
    <div id="root"></div>
    <script type="module" src="./app.tsx"></script>
  </body>
</html>
```

Create `src/admin/app.tsx`:

```tsx
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Card, CardLabel, CardSub } from "../ui/components/Card.tsx";
import { Badge } from "../ui/components/Badge.tsx";
import { SignaAmount } from "../ui/components/SignaAmount.tsx";

/** The token is supplied via the URL once, then kept in memory only. */
const token = new URLSearchParams(location.search).get("token") ?? "";
const api = (path: string, init?: RequestInit) =>
  fetch(`/api/${path}`, { ...init, headers: { "x-admin-token": token } });

interface State {
  projection: { status: Record<string, unknown>; miners: unknown[] };
  health: { overall: string; conditions: { kind: string; message: string }[] } | null;
  openAlerts: { kind: string; severity: string; message: string }[];
  killSwitchReason: string | null;
  dryRun: {
    wouldSend: boolean;
    totalPlanck: string;
    recipients: { recipientId: string; planck: string }[];
    railsVerdict: { ok: boolean; violation?: string; detail?: string };
  };
}

function App() {
  const [state, setState] = useState<State | undefined>();
  const [busy, setBusy] = useState(false);

  const refresh = async () => setState((await (await api("state")).json()) as State);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);

  const act = async (path: string) => {
    setBusy(true);
    await api(path, { method: "POST" });
    await refresh();
    setBusy(false);
  };

  if (!state) return <main className="p-8 text-[var(--muted)]">Loading…</main>;

  const tone =
    state.health?.overall === "critical" ? "crit" : state.health?.overall === "warning" ? "warn" : "ok";

  return (
    <main
      className="min-h-screen p-6"
      style={{ background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-body)" }}
    >
      <h1
        className="mb-6 text-[18px] uppercase tracking-[6px]"
        style={{ fontFamily: "var(--font-display)", color: "var(--blue2)" }}
      >
        Testnet Rewards — Admin
      </h1>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardLabel>Service health</CardLabel>
          <Badge tone={tone}>{state.health?.overall ?? "unknown"}</Badge>
          {state.health?.conditions.map((c) => (
            <CardSub key={c.kind}>{c.message}</CardSub>
          ))}
        </Card>

        <Card>
          <CardLabel>Kill switch</CardLabel>
          <Badge tone={state.killSwitchReason ? "crit" : "ok"}>
            {state.killSwitchReason ? "tripped" : "clear"}
          </Badge>
          {state.killSwitchReason && <CardSub>{state.killSwitchReason}</CardSub>}
        </Card>

        <Card>
          <CardLabel>Next batch (dry run)</CardLabel>
          <p className="text-[26px]" style={{ fontFamily: "var(--font-display)" }}>
            <SignaAmount planck={state.dryRun.totalPlanck} />
          </p>
          <CardSub>
            {state.dryRun.recipients.length} recipients ·{" "}
            {state.dryRun.wouldSend ? "would send" : "blocked"}
          </CardSub>
          {!state.dryRun.railsVerdict.ok && (
            <CardSub>
              rail: {state.dryRun.railsVerdict.violation} — {state.dryRun.railsVerdict.detail}
            </CardSub>
          )}
        </Card>
      </div>

      <div className="mt-6 flex gap-3">
        <button disabled={busy} onClick={() => void act("pause")} style={btn}>
          Pause payouts
        </button>
        <button disabled={busy} onClick={() => void act("resume")} style={btn}>
          Resume payouts
        </button>
        <button disabled={busy} onClick={() => void act("kill-switch/clear")} style={btn}>
          Clear kill switch
        </button>
      </div>

      <Card className="mt-6">
        <CardLabel>Open alerts</CardLabel>
        {state.openAlerts.length === 0 ? (
          <CardSub>none</CardSub>
        ) : (
          state.openAlerts.map((a) => (
            <CardSub key={a.kind}>
              [{a.severity}] {a.kind} — {a.message}
            </CardSub>
          ))
        )}
      </Card>
    </main>
  );
}

const btn: React.CSSProperties = {
  border: "1px solid var(--border2)",
  color: "var(--blue2)",
  background: "var(--surface-tint)",
  padding: "8px 16px",
  fontSize: 10,
  letterSpacing: 2,
  textTransform: "uppercase",
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
```

- [ ] **Step 10: Verify the page renders**

```bash
bun run src/main.ts &
sleep 3
curl -s "http://127.0.0.1:3100/api/state?token=$ADMIN_TOKEN" | head -c 300
```

Expected: a JSON object containing `projection`, `health` and `dryRun`. Then open `http://<pi-lan-ip>:3100/?token=<ADMIN_TOKEN>` in a browser and confirm the dark `nexus` theme renders with bracketed card corners.

- [ ] **Step 11: Commit**

```bash
git add src/ui src/admin bunfig.toml tests/admin package.json bun.lock
git commit -m "feat: add admin UI on the shared signum design system"
```

---

## Task 21: Composition root, pm2 and configuration

**Files:**
- Create: `src/main.ts`
- Create: `config/ecosystem.config.cjs`
- Create: `config/.env.example`
- Modify: `docs/superpowers/specs/2026-09-05-signum-testnet-rewards-design.md`
- Delete: `index.ts`

- [ ] **Step 1: Write the composition root**

Create `src/main.ts`:

```ts
import { loadConfig, resolvePaths } from "./config/load.ts";
import { openLedger } from "./ledger/db.ts";
import { createMainnetPool } from "./chain/mainnetPool.ts";
import { createTestnetClient } from "./chain/testnetClient.ts";
import { getFreshAccount, upsertAccount } from "./ledger/mainnetAccounts.ts";
import type { MainnetAccountFacts } from "./eligibility/eligibility.ts";
import { createIndexer } from "./indexer/indexer.ts";
import { createWsMonitor } from "./health/wsMonitor.ts";
import { createHttpProbe } from "./health/httpProbe.ts";
import { createHealthMonitor } from "./health/monitor.ts";
import { createNotifier } from "./notify/notifier.ts";
import { createTelegramChannel } from "./notify/telegram.ts";
import { createDiscordChannel } from "./notify/discord.ts";
import { createEmailChannel } from "./notify/email.ts";
import type { Channel } from "./notify/channel.ts";
import { buildProjection } from "./publish/projection.ts";
import { createTursoPublisher } from "./publish/tursoPublisher.ts";
import { createAdminServer } from "./admin/server.ts";
import { toChainDay } from "./domain/chainDay.ts";
import { ChainTime } from "@signumjs/util";
import { pruneHealthSamples } from "./ledger/healthSamples.ts";

// Config validation runs FIRST and throws before anything opens a database.
// The volume sentinel check lives inside loadConfig for exactly this reason.
const config = loadConfig();
const paths = resolvePaths(config);
const db = openLedger(paths.databasePath);

console.log(`[boot] data dir ${config.dataDir}`);
console.log(`[boot] payouts ${config.payouts.enabled ? "ENABLED" : "DISABLED (shadow mode)"}`);

const mainnet = createMainnetPool(config.chain.mainnetNodeHosts);
const testnet = createTestnetClient(config.chain.testnetNodeHost);

/** Cached mainnet lookup. Negative results expire sooner so activation takes effect quickly. */
async function lookupMainnetAccount(accountId: string): Promise<MainnetAccountFacts | undefined> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cached = getFreshAccount(
    db,
    accountId,
    {
      positiveSeconds: config.publish.accountTtlPositiveSeconds,
      negativeSeconds: config.publish.accountTtlNegativeSeconds,
    },
    nowSeconds,
  );
  if (cached) return { isActive: cached.isActive, publicKey: cached.publicKey };

  const account = await mainnet.getAccount(accountId);
  const facts = {
    accountId,
    publicKey: account?.publicKey ?? null,
    isActive: Boolean(account?.publicKey),
  };
  upsertAccount(db, facts, nowSeconds);
  return { isActive: facts.isActive, publicKey: facts.publicKey };
}

const channels: Channel[] = [];
if (config.notify.telegram) channels.push(createTelegramChannel(config.notify.telegram));
if (config.notify.discord) channels.push(createDiscordChannel(config.notify.discord));
if (config.notify.email) channels.push(createEmailChannel(config.notify.email));
console.log(`[boot] notification channels: ${channels.map((c) => c.name).join(", ") || "none"}`);

const notifier = createNotifier({ db, channels });
const wsMonitor = createWsMonitor(config.chain.testnetWsUrl);
const healthMonitor = createHealthMonitor({
  db,
  config,
  wsMonitor,
  probe: createHttpProbe(testnet),
  intervalMs: 60_000,
});

const publisher = createTursoPublisher({
  url: config.publish.tursoDatabaseUrl,
  authToken: config.publish.tursoAuthToken,
});

const indexer = createIndexer({
  db,
  config,
  walkerCachePath: paths.walkerCachePath,
  lookupMainnetAccount,
  isExcluded: () => false,
  onBlockObserved: () => {},
});

const adminServer = createAdminServer({
  db,
  token: config.admin.token,
  host: config.admin.bindHost,
  port: config.admin.port,
  minPayout: config.minPayout,
  rails: config.rails,
  globalDailyBudget: config.policy.globalDailyBudget,
  getHealth: () => healthMonitor.getLatest(),
});
console.log(`[boot] admin UI on ${adminServer.url}`);

async function publishTick() {
  try {
    await publisher.publish(
      buildProjection(db, {
        nowEpochSeconds: Math.floor(Date.now() / 1000),
        chainDay: toChainDay(ChainTime.fromDate(new Date()).getChainTimestamp()),
        recentPayoutLimit: 20,
        globalDailyBudget: config.policy.globalDailyBudget,
      }),
    );
  } catch (e) {
    // Publishing is best-effort: the next tick republishes from live state, so a
    // failure needs no queue and must never stop indexing.
    console.error("[publish] failed:", e instanceof Error ? e.message : e);
  }
}

healthMonitor.start();
const publishTimer = setInterval(() => void publishTick(), config.publish.intervalSeconds * 1000);
const notifyTimer = setInterval(() => void notifier.flush(), 30_000);
const pruneTimer = setInterval(
  () => pruneHealthSamples(db, Math.floor(Date.now() / 1000) - 30 * 86_400),
  6 * 3_600_000,
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  clearInterval(publishTimer);
  clearInterval(notifyTimer);
  clearInterval(pruneTimer);
  healthMonitor.stop();
  adminServer.stop();
  await indexer.stop();
  publisher.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Runs until stopped. walk() catches up, then listen() takes over.
await indexer.run();
```

- [ ] **Step 2: Write the pm2 config**

Create `config/ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: "signum-testnet-rewards",
      script: "src/main.ts",
      // Absolute: pm2's PATH is not your login shell's.
      interpreter: "/home/pi/.bun/bin/bun",
      cwd: "/home/pi/signum-testnet-rewards",

      // LOAD-BEARING, not a tuning knob. Two instances would mean two SQLite
      // writers and two payout batches in flight, breaking the single-batch
      // invariant that crash reconciliation depends on. Do not raise this.
      instances: 1,

      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      max_memory_restart: "400M",
      time: true,
    },
  ],
};
```

- [ ] **Step 3: Write the example environment**

Create `config/.env.example`:

```
# Money settings are declared in SIGNA, not planck. All are REQUIRED with no
# defaults: the service refuses to start rather than pay a guessed amount.
# Agreed parameters: ~900 SIGNA/day at Signum's ~360 blocks/day.
REWARD_PER_BLOCK_SIGNA=2.5
ACCOUNT_DAILY_CAP_SIGNA=100
GLOBAL_DAILY_BUDGET_SIGNA=1000
MIN_PAYOUT_SIGNA=5
MAX_PER_RECIPIENT_PER_BATCH_SIGNA=200
MAX_PER_BATCH_SIGNA=2000
MAX_PER_WALLCLOCK_DAY_SIGNA=3000
MIN_WALLET_BALANCE_SIGNA=5000
MAX_FEE_SIGNA=1

# --- chain ---
TESTNET_NODE_HOST=http://localhost:6876
TESTNET_WS_URL=ws://localhost:6877/events
MAINNET_NODE_HOSTS=<node-1>,<node-2>
START_HEIGHT=<height at first launch>
BLOCK_OFFSET=2
WALKER_INTERVAL_SECONDS=5

# --- payouts (Phase 2; keep false during shadow mode) ---
PAYOUTS_ENABLED=false
PAYOUT_INTERVAL_MINUTES=360
TX_DEADLINE_MINUTES=30
CONFIRMATIONS_REQUIRED=3
# PAYOUT_ACCOUNT_SEED must NEVER be committed. chmod 600 the real .env.
PAYOUT_ACCOUNT_SEED=

# --- health ---
STALL_THRESHOLD_MINUTES=15
MIN_PEERS=3
SYNC_LAG_BLOCKS=5
ALERT_OPEN_AFTER_CHECKS=3
ALERT_CLOSE_AFTER_CHECKS=3

# --- publishing ---
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
PUBLISH_INTERVAL_SECONDS=30
STALENESS_THRESHOLD_SECONDS=180
MAINNET_ACCOUNT_TTL_POSITIVE_SECONDS=86400
MAINNET_ACCOUNT_TTL_NEGATIVE_SECONDS=3600

# --- storage: must be on the HDD, and the sentinel must exist ---
DATA_DIR=/mnt/hdd/signum-rewards

# --- notifications: each channel activates only if fully configured ---
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
RESEND_API_KEY=
ALERT_EMAIL_TO=

# --- admin: bind to the LAN interface, NOT 0.0.0.0 ---
ADMIN_BIND_HOST=192.168.1.50
ADMIN_PORT=3100
ADMIN_TOKEN=
```

- [ ] **Step 4: Remove the scaffold entry point**

```bash
git rm index.ts
```

- [ ] **Step 5: Sync the spec with the two deliberate deviations**

In `docs/superpowers/specs/2026-09-05-signum-testnet-rewards-design.md`, update the `.env.example` block in section 7 to the SIGNA-denominated names above, and add to section 1's decision table:

```
| D9 | Money amounts use `Amount` from `@signumjs/util`; SQLite stores whole planck | Removes planck-vs-SIGNA ambiguity from every signature while keeping SQL SUM() exact |
| D10 | Repo relicensed MIT → GPL-3.0-or-later | Enables reuse of signum-node's GPL design system in both UIs |
```

- [ ] **Step 6: Full verification**

```bash
bun test
bunx tsc --noEmit
```

Expected: every test passes and the typecheck is clean. Record the actual counts; do not claim success without reading the output.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add composition root, pm2 config and example environment"
```

---

## Deferred to Phase 2

Not built here, and deliberately so — this plan stops before real money moves:

- `src/payout/broadcast.ts` — multi-out construction, local signing, node-pool broadcast, the single-recipient `sendAmount` fallback, and suggested-fee handling
- `src/payout/reconcile.ts` — fingerprint matching of un-confirmed batches against the chain, and deadline-driven `failed` transitions
- `src/payout/scheduler.ts` — the interval trigger, rail evaluation and kill-switch tripping
- The Vercel status page (`web/`), which is its own plan

Phase 2 should not begin until shadow mode has run against live testnet for a week and the dry-run output has been checked by hand against the chain.

Two Turso tables are created by `config/turso-schema.sql` but deliberately left
unpopulated in Phase 1, because only the status page consumes them:

- `health_history` — the downsampled sparkline series. `health_samples` is
  already recorded and pruned locally (Task 17), so the publisher only needs a
  downsampling query added when the page is built.
- `payout_recipients` — per-recipient payout detail, which cannot exist until
  Phase 2 confirms a real batch.

Creating the tables now keeps one schema file authoritative; publishing into them
belongs to the plan that builds the page that reads them.
