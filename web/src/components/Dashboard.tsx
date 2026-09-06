"use client";

import useSWR from "swr";
import { fromWire } from "@/lib/readModel";
import type { Miner, Payout, Snapshot, Status } from "@/lib/readModel";
import type { StatusResponse } from "@/app/api/status/route";
import { MINER_LIMIT, PAYOUT_LIMIT } from "@/lib/queries";
import { absoluteTime, formatSigna, relativeTime, shortId } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { Card, CardLabel, CardSub } from "@/components/Card";
import { Badge } from "@/components/Badge";
import type { Tone } from "@/components/Badge";
import { SignaAmount } from "@/components/SignaAmount";

/**
 * Matches the publisher's tick and the API route's cache window. Polling faster
 * cannot surface anything newer — it would only re-read the CDN.
 */
const REFRESH_MS = 30_000;

const fetcher = async (url: string): Promise<StatusResponse> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as StatusResponse;
};

export interface DashboardProps {
  /** Server-rendered first paint. Also the value SWR shows until its first poll. */
  initial: StatusResponse;
  /** The server's clock at render time, so hydration matches. */
  serverNow: number;
  stalenessSeconds: number;
}

/**
 * The live view.
 *
 * The whole page moves together rather than only the status banner: everything
 * here comes from ONE batched read, and a banner claiming "published 5 seconds
 * ago" above a miner table from ten minutes earlier would be worse than a page
 * that is uniformly a little old.
 */
export function Dashboard({ initial, serverNow, stalenessSeconds }: DashboardProps) {
  const { data, error } = useSWR<StatusResponse>("/api/status", fetcher, {
    fallbackData: initial,
    refreshInterval: REFRESH_MS,
    revalidateOnFocus: true,
    // A failed poll keeps the last good snapshot on screen and is reported by
    // the `offline` badge. Blanking the page because one request failed would
    // throw away data that is still perfectly valid, just ageing.
    keepPreviousData: true,
  });

  const now = useNow(serverNow);
  const result = data ?? initial;

  if (result.kind !== "ok") {
    return (
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
    );
  }

  const snapshot: Snapshot = fromWire(result.snapshot);
  const { status, miners, payouts } = snapshot;
  const stale = now - status.updatedAt > stalenessSeconds;

  return (
    <>
      <ServiceBanner status={status} stale={stale} offline={Boolean(error)} now={now} />
      <Headline status={status} now={now} />
      <MinerTable miners={miners} status={status} now={now} />
      <PayoutTable payouts={payouts} now={now} />
      <Footnote status={status} now={now} />
    </>
  );
}

/**
 * The one line a visitor reads first: is this working, and is what I am looking
 * at current?
 *
 * Staleness, service health and a failed poll are three separate badges. They
 * are different failures — this website being behind, the service being
 * degraded, and this browser being unable to reach the API — and collapsing
 * them into one indicator would make any of the three look like all of them.
 */
function ServiceBanner({
  status,
  stale,
  offline,
  now,
}: {
  status: Status;
  stale: boolean;
  offline: boolean;
  now: number;
}) {
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
        {offline && <Badge tone="warn">offline</Badge>}
        <span className="ml-auto text-[10px] tracking-[1px] text-[var(--muted)]">
          published{" "}
          <time dateTime={new Date(status.updatedAt * 1000).toISOString()}>
            {relativeTime(status.updatedAt, now)}
          </time>{" "}
          · {absoluteTime(status.updatedAt)}
        </span>
      </div>
      {status.openAlerts.length > 0 && (
        <CardSub>Open alerts: {status.openAlerts.join(", ").replace(/_/g, " ")}</CardSub>
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

function MinerTable({ miners, status, now }: { miners: Miner[]; status: Status; now: number }) {
  const unpayable = miners.filter((m) => m.mainnetAccount === "inactive").length;

  return (
    <Card>
      <CardLabel>Miners — top {Math.min(MINER_LIMIT, miners.length)} by amount owed</CardLabel>
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
                      <span className="ml-1 text-[10px] text-[var(--muted)]">({m.accountId})</span>
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
        {status.lastPayoutAt !== null &&
          `; the last batch settled ${relativeTime(status.lastPayoutAt, now)}`}
        .
      </p>
      <p className="mt-1">
        This page is a snapshot published by the rewards service, refreshed every 30 seconds. The
        service&apos;s own ledger is authoritative.
      </p>
    </footer>
  );
}
