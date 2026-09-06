import { readSnapshot, MINER_LIMIT, PAYOUT_LIMIT } from "@/lib/queries";
import type { Miner, Payout, Status } from "@/lib/readModel";
import { absoluteTime, formatSigna, relativeTime, shortId } from "@/lib/format";
import { Card, CardLabel, CardSub } from "@/components/Card";
import { Badge } from "@/components/Badge";
import type { Tone } from "@/components/Badge";
import { SignaAmount } from "@/components/SignaAmount";

/**
 * Seconds between rebuilds.
 *
 * 60 is the floor worth using: it matches the service's publish heartbeat, so a
 * shorter window would re-read the same snapshot. It is also the only knob that
 * decides this page's database cost — see the arithmetic in `lib/queries.ts`
 * before lowering it.
 */
export const revalidate = 60;

const STALENESS_SECONDS = Number(process.env.NEXT_PUBLIC_STALENESS_SECONDS ?? 300);

export default async function Page() {
  const result = await readSnapshot();
  // Rendered once per revalidation, so every "ago" on the page is accurate as
  // of the snapshot rather than the visitor's clock — which is the honest
  // reading anyway: the data is exactly as old as the last publish.
  const now = Math.floor(Date.now() / 1000);

  if (result.kind !== "ok") {
    return (
      <main className="page-layout">
        <Header />
        <Card>
          <CardLabel>
            {result.kind === "unconfigured" ? "Not configured" : "No snapshot yet"}
          </CardLabel>
          <p>
            {result.kind === "unconfigured"
              ? "This deployment has no database to read."
              : "The rewards service has not published a status yet."}
          </p>
          <CardSub>
            {result.kind === "unconfigured"
              ? "Set TURSO_DATABASE_URL and a read-only TURSO_AUTH_TOKEN, then redeploy."
              : "This is the expected state before the service's first publish tick."}
          </CardSub>
        </Card>
      </main>
    );
  }

  const { status, miners, payouts } = result.snapshot;
  const stale = now - status.updatedAt > STALENESS_SECONDS;

  return (
    <main className="page-layout">
      <Header />
      <ServiceBanner status={status} stale={stale} now={now} />
      <Headline status={status} now={now} />
      <MinerTable miners={miners} status={status} now={now} />
      <PayoutTable payouts={payouts} now={now} />
      <Footnote status={status} now={now} />
    </main>
  );
}

function Header() {
  return (
    <header className="pt-2">
      <h1
        className="text-lg font-semibold uppercase tracking-[4px]"
        style={{ color: "var(--blue3)", textShadow: "var(--glow-b)" }}
      >
        Signum Testnet Rewards
      </h1>
      <p className="text-[10px] uppercase tracking-[2px] text-[var(--muted)]">
        Forge on testnet · paid in SIGNA on mainnet
      </p>
    </header>
  );
}

/**
 * The one line a visitor reads first: is this working, and is what I am looking
 * at current?
 *
 * Staleness is given its own badge rather than folded into the service status.
 * A stale page and a degraded service are different failures — the first is
 * about this website, the second is about the money — and merging them would
 * make an outage of either look like an outage of both.
 */
function ServiceBanner({ status, stale, now }: { status: Status; stale: boolean; now: number }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={status.serviceStatus === "ok" ? "ok" : "warn"}>
          {status.serviceStatus === "ok" ? "operational" : "degraded"}
        </Badge>
        {status.killSwitch && <Badge tone="crit">payouts halted</Badge>}
        {status.payoutsPaused && !status.killSwitch && <Badge tone="warn">payouts paused</Badge>}
        {!status.payoutsEnabled && !status.payoutsPaused && !status.killSwitch && (
          <Badge tone="muted">payouts not enabled</Badge>
        )}
        {stale && <Badge tone="warn">snapshot stale</Badge>}
        <span className="ml-auto text-[10px] tracking-[1px] text-[var(--muted)]">
          published <time dateTime={new Date(status.updatedAt * 1000).toISOString()}>
            {relativeTime(status.updatedAt, now)}
          </time>{" "}
          · {absoluteTime(status.updatedAt)}
        </span>
      </div>
      {status.openAlerts.length > 0 && (
        <CardSub>
          Open alerts: {status.openAlerts.join(", ").replace(/_/g, " ")}
        </CardSub>
      )}
    </Card>
  );
}

function Headline({ status, now }: { status: Status; now: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardLabel>Pending</CardLabel>
        <p className="text-2xl" style={{ color: "var(--gold)" }}>
          <SignaAmount planck={status.pendingPlanck} />
        </p>
        <CardSub>owed to {status.minerCount} miners</CardSub>
      </Card>

      <Card>
        <CardLabel>Distributed</CardLabel>
        <p className="text-2xl" style={{ color: "var(--green)" }}>
          <SignaAmount planck={status.totalDistributedPlanck} />
        </p>
        <CardSub>paid out to date</CardSub>
      </Card>

      <Card>
        <CardLabel>Next payout</CardLabel>
        <NextPayout status={status} now={now} />
      </Card>

      <Card>
        <CardLabel>Budget remaining</CardLabel>
        <p className="text-2xl" style={{ color: "var(--blue3)" }}>
          <SignaAmount planck={status.budgetRemainingPlanck} />
        </p>
        <CardSub>today&apos;s allowance</CardSub>
      </Card>
    </div>
  );
}

const BLOCKER_TEXT: Record<NonNullable<Status["payoutBlockedBy"]>, string> = {
  disabled: "payouts are not enabled",
  paused: "payouts are paused by an operator",
  kill_switch: "payouts are halted by the kill switch",
};

/**
 * `nextPayoutAt` and `payoutBlockedBy` are mutually exclusive by construction in
 * the service, so this shows exactly one of them and never invents a date for a
 * cycle that will not run.
 */
function NextPayout({ status, now }: { status: Status; now: number }) {
  if (status.payoutBlockedBy) {
    return (
      <>
        <p className="text-lg" style={{ color: "var(--amber)" }}>
          none scheduled
        </p>
        <CardSub>{BLOCKER_TEXT[status.payoutBlockedBy]}</CardSub>
      </>
    );
  }
  if (status.nextPayoutAt === null) {
    return (
      <>
        <p className="text-lg text-[var(--muted)]">unknown</p>
        <CardSub>no schedule published</CardSub>
      </>
    );
  }
  return (
    <>
      <p className="text-lg" style={{ color: status.payoutDue ? "var(--amber)" : "var(--blue3)" }}>
        {status.payoutDue ? "due now" : relativeTime(status.nextPayoutAt, now)}
      </p>
      <CardSub>{absoluteTime(status.nextPayoutAt)}</CardSub>
    </>
  );
}

const MAINNET_BADGE: Record<Miner["mainnetAccount"], { tone: Tone; text: string }> = {
  active: { tone: "ok", text: "payable" },
  inactive: { tone: "warn", text: "no mainnet acct" },
  unknown: { tone: "muted", text: "unchecked" },
};

function MinerTable({
  miners,
  status,
  now,
}: {
  miners: Miner[];
  status: Status;
  now: number;
}) {
  const unpayable = miners.filter((m) => m.mainnetAccount === "inactive").length;

  return (
    <Card>
      <CardLabel>
        Miners — top {Math.min(MINER_LIMIT, miners.length)} by amount owed
      </CardLabel>
      {miners.length === 0 ? (
        <p className="text-[var(--muted)]">No miners have forged a block yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="w-full min-w-[720px] text-left text-[12px]">
            <thead>
              <tr className="text-[9px] uppercase tracking-[2px] text-[var(--muted)]">
                <th className="py-2 pr-4 font-semibold">Account</th>
                <th className="py-2 pr-4 font-semibold">Mainnet</th>
                <th className="py-2 pr-4 text-right font-semibold">Blocks</th>
                <th className="py-2 pr-4 text-right font-semibold">Pending</th>
                <th className="py-2 pr-4 text-right font-semibold">Paid</th>
                <th className="py-2 text-right font-semibold">Last block</th>
              </tr>
            </thead>
            <tbody>
              {miners.map((m) => {
                const badge = MAINNET_BADGE[m.mainnetAccount];
                return (
                  <tr key={m.accountId} style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="py-2 pr-4">
                      <span className="font-mono">{m.accountRS ?? shortId(m.accountId)}</span>
                      <span className="ml-1 text-[10px] text-[var(--muted)]">
                        ({m.accountId})
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge tone={badge.tone}>{badge.text}</Badge>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {m.blocksMined}
                      {m.blocksSkipped > 0 && (
                        <span className="text-[var(--muted)]"> +{m.blocksSkipped} skipped</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right" style={{ color: "var(--gold)" }}>
                      <SignaAmount planck={m.pendingPlanck} />
                    </td>
                    <td className="py-2 pr-4 text-right" style={{ color: "var(--green)" }}>
                      <SignaAmount planck={m.paidPlanck} />
                    </td>
                    <td className="py-2 text-right text-[var(--muted)]">
                      {m.lastBlockAt === null ? "—" : relativeTime(m.lastBlockAt, now)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <CardSub>
        {status.minerCount > miners.length
          ? `Showing ${miners.length} of ${status.minerCount} miners. `
          : ""}
        {unpayable > 0
          ? `${unpayable} shown here forge but have no active mainnet account, so they cannot be paid until they create one.`
          : "Rewards are paid to the same account id on mainnet, which must exist and have a public key set."}
      </CardSub>
    </Card>
  );
}

function PayoutTable({ payouts, now }: { payouts: Payout[]; now: number }) {
  return (
    <Card>
      <CardLabel>Recent payouts</CardLabel>
      {payouts.length === 0 ? (
        <p className="text-[var(--muted)]">No payout has been confirmed yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="w-full min-w-[560px] text-left text-[12px]">
            <thead>
              <tr className="text-[9px] uppercase tracking-[2px] text-[var(--muted)]">
                <th className="py-2 pr-4 font-semibold">Confirmed</th>
                <th className="py-2 pr-4 font-semibold">Transaction</th>
                <th className="py-2 pr-4 text-right font-semibold">Recipients</th>
                <th className="py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.batchId} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="py-2 pr-4 text-[var(--muted)]">
                    {p.confirmedAt === null ? "—" : relativeTime(p.confirmedAt, now)}
                  </td>
                  <td className="py-2 pr-4 font-mono">
                    {p.txId ? shortId(p.txId) : <span className="text-[var(--muted)]">—</span>}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{p.recipientCount ?? "—"}</td>
                  <td className="py-2 text-right" style={{ color: "var(--green)" }}>
                    {p.totalPlanck === null ? "—" : <SignaAmount planck={p.totalPlanck} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <CardSub>Last {PAYOUT_LIMIT} confirmed batches.</CardSub>
    </Card>
  );
}

function Footnote({ status, now }: { status: Status; now: number }) {
  const { whole } = formatSigna(status.pendingPlanck, 0);
  return (
    <footer className="pb-6 text-[10px] leading-relaxed tracking-[1px] text-[var(--muted)]">
      <p>
        Blocks forged on the Signum <strong>testnet</strong> accrue a reward paid in real SIGNA on
        <strong> mainnet</strong>. {whole} SIGNA is currently owed
        {status.lastPayoutAt !== null && `; the last batch settled ${relativeTime(status.lastPayoutAt, now)}`}.
      </p>
      <p className="mt-1">
        This page is a snapshot published by the rewards service, refreshed at most once a minute.
        The service&apos;s own ledger is authoritative.
      </p>
    </footer>
  );
}
