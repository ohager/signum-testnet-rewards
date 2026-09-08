import { formatSignaPlain } from "@/lib/format";
import type { Status } from "@/lib/readModel";
import { Card, CardSub } from "@/components/Card";

/**
 * signum-node Constants.java: MAX_MULTI_OUT_RECIPIENTS. A protocol limit rather
 * than a policy of this programme, which is why it is stated here instead of
 * being published with the rules that an operator can retune.
 */
const MAX_RECIPIENTS_PER_TX = 64;

interface Rule {
  title: string;
  body: string;
}

/**
 * Builds the rules from the figures the service published.
 *
 * Each rule degrades to prose when its figure is missing, because a status row
 * written by an older build has no rule columns at all. Saying "a fixed reward"
 * is honest in that case; saying "0 SIGNA" would not be.
 */
function buildRules(status: Status): Rule[] {
  const { rewardPerBlockPlanck: reward, accountDailyCapPlanck: cap } = status;
  const { globalDailyBudgetPlanck: budget, minPayoutPlanck: minPayout } = status;

  // Whole blocks that fit under the cap, floored to match the service: a reward
  // is all-or-nothing, so a part-block of headroom is worth nothing.
  const blocksPerDay = cap !== null && reward !== null && reward > 0n ? cap / reward : null;

  return [
    {
      title: "Forge a block on testnet",
      body:
        "Every block you win on the Signum testnet is recorded here at the height you won it, " +
        "against the account credited with forging it.",
    },
    {
      title: "Mine solo, against a node of your own",
      body:
        "Ideally you mine solo and point the miner at a testnet node you run yourself. That is " +
        "another node carrying the chain, and every miner running one makes the testnet " +
        "steadier — which is the point of the exercise. A Signum test node is light enough to " +
        "sit alongside the miner on the same machine. Forge through a pool and you are still " +
        "credited — the block names you as its forger, whatever the pool does with the testnet " +
        "reward afterwards.",
    },
    {
      title: "Your mainnet plots already work",
      body:
        "There is nothing to re-plot. Plot files are bound to your numeric account id, and that " +
        "is the same id on both chains, so the plots you mine mainnet with forge on testnet as " +
        "they are. Point a miner at your own testnet node and go.",
    },
    {
      title:
        reward === null
          ? "Each rewarded block earns a fixed amount"
          : `Each rewarded block earns ${formatSignaPlain(reward)} SIGNA`,
      body:
        "All or nothing. A block is never paid a part reward, so a rewarded block is always " +
        "worth exactly this much.",
    },
    {
      title:
        cap === null
          ? "Each account has a daily cap"
          : `Up to ${formatSignaPlain(cap)} SIGNA per account per day`,
      body:
        (blocksPerDay === null
          ? "Once your day's cap is reached, "
          : `That is ${blocksPerDay} rewarded blocks a day. Once you reach it, `) +
        "every further block you forge is counted as skipped — still recorded, but earning " +
        "nothing. The count resets at 00:00 UTC, measured by the block's own timestamp rather " +
        "than by when we saw it.",
    },
    {
      title:
        budget === null
          ? "The programme has a daily budget"
          : `Up to ${formatSignaPlain(budget)} SIGNA a day across everyone`,
      body:
        "A budget shared by every miner. When a day's budget is used up, blocks are skipped " +
        "for all miners until it resets, however far below their own cap they are.",
    },
    {
      title: "Paid in real SIGNA on mainnet",
      body:
        "Rewards go to the same account id on mainnet that forged on testnet. That account must " +
        "already exist there with its public key set — until it does, your blocks are skipped " +
        "and nothing accrues.",
    },
    {
      // The threshold is a floor on YOUR balance, not on the size of the batch.
      // Phrased as a batch minimum it reads as though small payouts are skipped
      // entirely, when what actually happens is that your own accruals keep
      // adding up until they qualify.
      title:
        minPayout === null
          ? "Paid out in batches"
          : `Paid once your balance reaches ${formatSignaPlain(minPayout)} SIGNA`,
      body:
        minPayout === null
          ? "Rewards accrue to your account and are settled in cycles, oldest first. A single " +
            `transaction carries at most ${MAX_RECIPIENTS_PER_TX} recipients, so anyone beyond ` +
            "that waits for a later cycle — nothing is lost, and nothing expires."
          : "The minimum is per account, not per payout: your own accruals have to add up to " +
            `${formatSignaPlain(minPayout)} SIGNA before you are included, however much the ` +
            "programme pays out that cycle. Each cycle settles the oldest accruals first, and a " +
            `single transaction carries at most ${MAX_RECIPIENTS_PER_TX} recipients. A balance ` +
            "below the minimum, or beyond that limit, waits for a later cycle — nothing is " +
            "lost, and nothing expires.",
    },
  ];
}

/**
 * A one-line version of the rules for the collapsed card.
 *
 * Carries the two figures that explain the miner table's block counts, so
 * folding the card away costs the detail but never the explanation.
 */
function summarise(status: Status): string {
  const { rewardPerBlockPlanck: reward, accountDailyCapPlanck: cap } = status;
  if (reward === null || cap === null) return "Solo-forged testnet blocks, paid in SIGNA on mainnet.";
  return (
    `${formatSignaPlain(reward)} SIGNA per solo-forged testnet block, ` +
    `up to ${formatSignaPlain(cap)} SIGNA a day, paid in real SIGNA on mainnet.`
  );
}

/**
 * The rules, stated in the same figures the tables are counted in.
 *
 * This card exists because of one number. A miner reading "10 blocks, +122
 * skipped" is looking at a daily cap doing exactly its job, but with no cap on
 * screen that pair reads as the programme having mislaid 122 of their blocks.
 *
 * The figures come from the published status row and NOT from this page's own
 * configuration, so an operator retuning the service cannot leave a stale rule
 * on the website contradicting the ledger.
 *
 * Built on <details> rather than React state so it needs no client runtime and
 * still opens on a page that never hydrates. It ships CLOSED, which is why the
 * summary line carries the reward and the cap: folded away, the card must still
 * answer the question it was added for, and the detail is one click behind it.
 */
export function RewardRules({ status }: { status: Status }) {
  const rules = buildRules(status);

  return (
    <Card>
      <details className="rules">
        <summary>
          <span
            className="text-[9px] font-semibold uppercase tracking-[3px]"
            style={{ color: "var(--blue2)" }}
          >
            How rewards work
          </span>
          <span className="ml-3 text-[11px] text-[var(--muted)]">{summarise(status)}</span>
        </summary>

        <div className="rules-body">
          <ol className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
            {rules.map((rule, i) => (
              <li key={rule.title} className="flex gap-3">
                <span
                  className="mt-px shrink-0 text-[10px] font-semibold tabular-nums tracking-[1px]"
                  style={{ color: "var(--blue2)" }}
                  aria-hidden
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <p className="text-[12px] font-semibold" style={{ color: "var(--blue3)" }}>
                    {rule.title}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{rule.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <CardSub>
            These figures are the ones the service is running right now, republished with every
            snapshot. Skipped blocks are never paid retrospectively when a cap or budget resets.
          </CardSub>
        </div>
      </details>
    </Card>
  );
}
