import {Component, useEffect, useState} from "react";
import type {ErrorInfo, ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {Card, CardLabel, CardSub} from "./components/Card";
import {Badge, type Tone} from "./components/Badge";
import {SignaAmount} from "./components/SignaAmount";
import {SignumLogo} from "./components/SignumLogo";
import {AccountId, short, relative, btn} from "./components/display";
import {PayoutAccountCard, PayoutReleaseCard} from "./components/PayoutCards";
import type {LiveBatch, PayoutAccountRow, PayoutState} from "./components/PayoutCards";

/** The token is supplied via the URL once, then kept in memory only. */
const token = new URLSearchParams(location.search).get("token") ?? "";
const api = (path: string, init?: RequestInit) =>
    fetch(`/api/${path}`, {...init, headers: {"x-admin-token": token}});

interface MinerRow {
    accountId: string;
    accountRS: string;
    mainnetAccount: "active" | "inactive" | "unknown";
    blocksMined: number;
    blocksSkipped: number;
    pendingPlanck: number;
    paidPlanck: number;
    lastBlockAt: number | null;
    lastSkipReason: string | null;
}

interface StatusRow {
    payoutsEnabled: boolean;
    pendingPlanck: number;
    nextPayoutAt: number | null;
    payoutBlockedBy: string | null;
    payoutState: "blocked" | "pending" | "due" | "postponed";
    lastPayoutAt: number | null;
    totalDistributedPlanck: number;
}

interface HeadBlock {
    height: number;
    blockId: string;
    generationSignature: string;
    generatorId: string;
    generatorRS: string;
    forgedAt: number;
    observedAt: number;
}




interface ChannelRow {
    name: string;
    minSeverity: string;
    enabled: boolean;
}

interface Simulation {
    built: boolean;
    reason?: string;
    error?: string;
    recipientCount: number;
    totalPlanck: string;
    feePlanck: string;
    requiresOrdinarySend: boolean;
    transaction?: { signatureHash: string; unsignedTransactionBytes: string; transactionJSON: object };
}

interface State {
    projection: { status: StatusRow; miners: MinerRow[] };
    channels: ChannelRow[];
    simulationAvailable: boolean;
    /** Null when PAYOUT_ACCOUNT_SEED is unset: there is no account to report. */
    payoutAccount: PayoutAccountRow | null;
    payout: PayoutState;
    chain: {
        head: HeadBlock | null;
        indexed: { height: number; blockId: string; generatorRS: string } | null;
        blocksBehind: number | null;
    };
    health: { overall: string; conditions: { kind: string; message: string }[] } | null;
    fork: {
        verdict: string;
        confirmed: boolean;
        height: number | null;
        blockId: string | null;
        generationSignature: string | null;
        message: string;
        agreeing: string[];
        disagreeing: string[];
        abstaining: string[];
    } | null;
    openAlerts: { kind: string; severity: string; message: string }[];
    killSwitchReason: string | null;
    dryRun: {
        wouldSend: boolean;
        totalPlanck: string;
        recipients: { recipientId: string; planck: string }[];
        railsVerdict: { ok: boolean; violation?: string; detail?: string };
    };
}

/**
 * The eligibility gate, per miner. "unknown" is muted rather than red: the
 * lookup cache is pruned by retention, so an absent entry means we have not
 * checked recently, not that the account is missing.
 */
const MAINNET_STATE: Record<string, { tone: Tone; label: string }> = {
    active: {tone: "ok", label: "payable"},
    inactive: {tone: "warn", label: "no mainnet acct"},
    unknown: {tone: "muted", label: "unchecked"},
};

const BLOCKED_LABEL: Record<string, string> = {
    disabled: "payouts disabled (shadow mode)",
    paused: "payouts paused",
    kill_switch: "kill switch tripped",
};

const stamp = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleString();

/**
 * The address a person recognises, followed by the id every API and log line
 * uses. Both are shown because they identify the same account to different
 * readers, and having to convert between them by hand is the whole friction
 * this replaces.
 */






/**
 * Catches a render-time throw and shows what happened.
 *
 * Without one, React unmounts the whole tree on any error and leaves a blank
 * page — the single worst outcome for an operations panel, because a blank page
 * looks identical to a dead service. The panel polls every five seconds, so an
 * error here is usually a shape mismatch against a newer API rather than
 * something a retry fixes; the message and a reload are the useful response.
 */
class ErrorBoundary extends Component<{children: ReactNode}, {error: Error | undefined}> {
    override state: {error: Error | undefined} = {error: undefined};

    static getDerivedStateFromError(error: Error) {
        return {error};
    }

    override componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("admin panel crashed", error, info.componentStack);
    }

    override render() {
        const {error} = this.state;
        if (!error) return this.props.children;
        return (
            <main
                className="min-h-screen p-6"
                style={{background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-body)"}}
            >
                <Card>
                    <CardLabel>Admin panel error</CardLabel>
                    <Badge tone="crit">crashed</Badge>
                    <CardSub>{error.message}</CardSub>
                    <CardSub>
                        The service itself is unaffected: this is the panel only. Indexing, alerting
                        and publishing continue.
                    </CardSub>
                    <div className="mt-4">
                        <button onClick={() => location.reload()} style={btn}>Reload</button>
                    </div>
                </Card>
            </main>
        );
    }
}

function App() {
    const [state, setState] = useState<State | undefined>();
    const [busy, setBusy] = useState(false);
    const [testResult, setTestResult] = useState<string | undefined>();
    const [simulation, setSimulation] = useState<Simulation | undefined>();
    const [releaseResult, setReleaseResult] = useState<string | undefined>();
    // Two-step, because the click is irreversible and moves real money.
    const [confirmRelease, setConfirmRelease] = useState(false);
    const [fetchError, setFetchError] = useState<string | undefined>();

    /**
     * A failed poll never clears the last good state: showing five-second-old
     * numbers under a warning is more useful than showing nothing, and a blank
     * panel during a brief blip would be indistinguishable from a dead service.
     */
    const refresh = async () => {
        try {
            const res = await api("state");
            if (res.status === 401) {
                setFetchError("Unauthorized — the ?token in the URL is missing or wrong.");
                return;
            }
            if (!res.ok) {
                setFetchError(`Service returned ${res.status} ${res.statusText}`);
                return;
            }
            setState((await res.json()) as State);
            setFetchError(undefined);
        } catch (e) {
            setFetchError(`Cannot reach the service: ${e instanceof Error ? e.message : String(e)}`);
        }
    };
    useEffect(() => {
        void refresh();
        const t = setInterval(() => void refresh(), 5000);
        return () => clearInterval(t);
    }, []);

    // try/finally throughout: a throw that skipped setBusy(false) would leave
    // every button on the panel disabled until a manual reload.
    const act = async (path: string) => {
        setBusy(true);
        try {
            await api(path, {method: "POST"});
            await refresh();
        } catch (e) {
            setFetchError(`Request failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    const post = async (path: string, payload: unknown) => {
        setBusy(true);
        try {
            const res = await api(path, {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify(payload),
            });
            const json = (await res.json()) as { ok?: boolean; error?: string; channel?: string };
            setTestResult(
                json.ok === false || json.error
                    ? `${json.channel ?? "request"} failed: ${json.error ?? "unknown error"}`
                    : `${json.channel ?? "done"}: sent`,
            );
            await refresh();
        } catch (e) {
            setTestResult(`request failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    /**
     * Releases the batch.
     *
     * Reports the runner's outcome verbatim rather than a generic "done": the
     * difference between `sent`, `blocked` and `send-failed` is the difference
     * between money gone, nothing happened, and outcome unknown, and only the
     * middle one is safe to shrug at.
     */
    const release = async (expectedTotalPlanck: string) => {
        setBusy(true);
        setReleaseResult(undefined);
        try {
            const res = await api("payout/release", {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({expectedTotalPlanck}),
            });
            const out = (await res.json()) as {
                kind?: string; reason?: string; txId?: string; error?: string;
            };
            if (out.error) setReleaseResult(`failed: ${out.error}`);
            else if (out.kind === "sent") setReleaseResult(`sent — tx ${out.txId}`);
            else if (out.kind === "blocked") setReleaseResult(`blocked: ${out.reason}`);
            else if (out.kind === "send-failed")
                setReleaseResult("send failed — outcome unknown, the reconciler will resolve it");
            else setReleaseResult(out.kind ?? "unknown outcome");
            await refresh();
        } catch (e) {
            // A network failure here says nothing about whether the payout went
            // out; the batch state on the next refresh does.
            setReleaseResult(
                `request failed — check the batch state: ${e instanceof Error ? e.message : String(e)}`,
            );
            await refresh();
        } finally {
            setBusy(false);
            setConfirmRelease(false);
        }
    };

    const simulate = async () => {
        setBusy(true);
        setSimulation(undefined);
        try {
            const res = await api("payout/simulate", {method: "POST"});
            setSimulation((await res.json()) as Simulation);
        } catch (e) {
            setSimulation({
                built: false,
                error: e instanceof Error ? e.message : String(e),
                recipientCount: 0, totalPlanck: "0", feePlanck: "0",
                requiresOrdinarySend: false,
            });
        } finally {
            setBusy(false);
        }
    };

    if (!state) {
        return (
            <main className="p-8 text-[var(--muted)]">
                {fetchError ?? "Loading…"}
            </main>
        );
    }

    const {status, miners} = state.projection;
    const chain = state.chain;
    const now = Math.floor(Date.now() / 1000);

    const tone: Tone =
        state.health?.overall === "critical"
            ? "crit"
            : state.health?.overall === "warning"
                ? "warn"
                : "ok";

    // "unknown" is deliberately not an error tone: an unreachable reference node
    // says nothing about our chain.
    const forkTone: Tone =
        state.fork?.verdict === "forked"
            ? "crit"
            : state.fork?.verdict === "references_disagree"
                ? "warn"
                : "ok";

    return (
        <main
            className="min-h-screen p-6"
            style={{background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-body)"}}
        >
            <header className="mb-6 flex items-center gap-3">
                <SignumLogo size={36} className="shrink-0 text-[var(--blue2)]"/>
                <h1
                    className="text-[18px] uppercase tracking-[6px]"
                    style={{fontFamily: "var(--font-display)", color: "var(--blue2)"}}
                >
                    Testnet Rewards — Admin
                </h1>
            </header>

            {fetchError && (
                <Card className="mb-4">
                    <CardLabel>Connection</CardLabel>
                    <Badge tone="warn">stale</Badge>
                    <CardSub>{fetchError}</CardSub>
                    <CardSub>Showing the last values received.</CardSub>
                </Card>
            )}

            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardLabel>Local chain</CardLabel>
                    {chain.head ? (
                        <>
                            <p className="text-[26px] tabular-nums"
                               style={{fontFamily: "var(--font-display)"}}>
                                {chain.head.height.toLocaleString()}
                            </p>
                            <CardSub>
                                forged by{" "}
                                <AccountId rs={chain.head.generatorRS} id={chain.head.generatorId}/>
                            </CardSub>
                            <CardSub>
                                {relative(chain.head.forgedAt, now)} · block {chain.head.blockId}
                            </CardSub>
                            <CardSub>gen sig {short(chain.head.generationSignature)}</CardSub>
                        </>
                    ) : (
                        <>
                            <Badge tone="warn">unknown</Badge>
                            <CardSub>the node has not described its head block yet</CardSub>
                        </>
                    )}
                    <CardSub>
                        {chain.indexed === null
                            ? "nothing indexed yet"
                            : `indexed to ${chain.indexed.height.toLocaleString()}` +
                            (chain.blocksBehind === null ? "" : ` (${chain.blocksBehind} behind)`)}
                    </CardSub>
                </Card>

                <Card>
                    <CardLabel>Service health</CardLabel>
                    <Badge tone={tone}>{state.health?.overall ?? "unknown"}</Badge>
                    {state.health?.conditions.map((c) => (
                        <CardSub key={c.kind}>{c.message}</CardSub>
                    ))}
                </Card>

                <Card>
                    <CardLabel>Chain fork</CardLabel>
                    <Badge tone={forkTone}>{state.fork?.verdict ?? "disabled"}</Badge>
                    <CardSub>
                        {state.fork
                            ? state.fork.message
                            : "No reference nodes configured — chain history is not being compared."}
                    </CardSub>
                    {state.fork?.height != null && (
                        <CardSub>
                            compared height {state.fork.height.toLocaleString()}
                            {state.fork.generationSignature
                                ? ` · gen sig ${short(state.fork.generationSignature)}`
                                : ""}
                        </CardSub>
                    )}
                    {chain.head && (
                        <CardSub>
                            head {chain.head.height.toLocaleString()} · gen sig{" "}
                            {short(chain.head.generationSignature)}
                        </CardSub>
                    )}
                    {state.fork && state.fork.verdict !== "agreed" && !state.fork.confirmed && (
                        <CardSub>unconfirmed — awaiting another check</CardSub>
                    )}
                </Card>

                <Card>
                    <CardLabel>Kill switch</CardLabel>
                    <Badge tone={state.killSwitchReason ? "crit" : "ok"}>
                        {state.killSwitchReason ? "tripped" : "clear"}
                    </Badge>
                    {state.killSwitchReason && <CardSub>{state.killSwitchReason}</CardSub>}
                </Card>

                <Card>
                    <CardLabel>Next payout</CardLabel>
                    {status.nextPayoutAt === null ? (
                        <>
                            <Badge tone="warn">none scheduled</Badge>
                            <CardSub>
                                {BLOCKED_LABEL[status.payoutBlockedBy ?? ""] ?? "not scheduled"}
                            </CardSub>
                        </>
                    ) : status.payoutState === "postponed" ? (
                        /* The window has passed but nothing clears the minimum, so
                           the cycle waits on a balance rather than the clock. Showing
                           the elapsed time here would read as an overdue payment. */
                        <>
                            <p className="text-[22px]" style={{fontFamily: "var(--font-display)"}}>
                                waiting for the minimum
                            </p>
                            <CardSub>due since {stamp(status.nextPayoutAt)}</CardSub>
                        </>
                    ) : (
                        <>
                            <p className="text-[22px]" style={{fontFamily: "var(--font-display)"}}>
                                {status.payoutState === "due"
                                    ? "due now"
                                    : relative(status.nextPayoutAt, now)}
                            </p>
                            <CardSub>{stamp(status.nextPayoutAt)}</CardSub>
                        </>
                    )}
                    <CardSub>
                        {status.lastPayoutAt === null
                            ? "no payout has run yet"
                            : `last run ${relative(status.lastPayoutAt, now)}`}
                    </CardSub>
                </Card>

                <Card>
                    <CardLabel>Pending to miners</CardLabel>
                    <p className="text-[26px]" style={{fontFamily: "var(--font-display)"}}>
                        <SignaAmount planck={String(status.pendingPlanck)}/>
                    </p>
                    <CardSub>
                        across {miners.filter((m) => m.pendingPlanck > 0).length} of {miners.length} miners
                    </CardSub>
                    <CardSub>
                        {miners.filter((m) => m.mainnetAccount === "inactive").length} without a
                        mainnet account — they forge but cannot be paid
                    </CardSub>
                </Card>

                <Card>
                    <CardLabel>Next batch (dry run)</CardLabel>
                    <p className="text-[26px]" style={{fontFamily: "var(--font-display)"}}>
                        <SignaAmount planck={state.dryRun.totalPlanck}/>
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

                <PayoutAccountCard
                    account={state.payoutAccount}
                    dueTotalPlanck={state.dryRun.totalPlanck}
                    now={now}
                />

                <PayoutReleaseCard
                    payout={state.payout}
                    dryRun={state.dryRun}
                    busy={busy}
                    confirming={confirmRelease}
                    result={releaseResult}
                    onArm={() => setConfirmRelease(true)}
                    onCancel={() => setConfirmRelease(false)}
                    onRelease={release}
                    now={now}
                />
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
                <CardLabel>Miners — pending first</CardLabel>
                {miners.length === 0 ? (
                    <CardSub>no blocks observed yet</CardSub>
                ) : (
                    <div className="mt-2 max-h-[420px] overflow-y-auto">
                        <table className="w-full text-[11px] tabular-nums">
                            <thead>
                            <tr className="text-left text-[9px] uppercase tracking-[2px] text-[var(--blue2)]">
                                <th className="py-1 pr-3 font-semibold">Account</th>
                                <th className="py-1 pr-3 font-semibold">Mainnet</th>
                                <th className="py-1 pr-3 text-right font-semibold">Pending</th>
                                <th className="py-1 pr-3 text-right font-semibold">Paid</th>
                                <th className="py-1 pr-3 text-right font-semibold">Blocks</th>
                                <th className="py-1 pr-3 text-right font-semibold">Skipped</th>
                                <th className="py-1 font-semibold">Last skip</th>
                            </tr>
                            </thead>
                            <tbody>
                            {miners.map((m) => (
                                <tr key={m.accountId} style={{borderTop: "1px solid var(--border)"}}>
                                    <td className="py-1 pr-3">
                                        <AccountId rs={m.accountRS} id={m.accountId}/>
                                    </td>
                                    <td className="py-1 pr-3">
                                        <Badge tone={MAINNET_STATE[m.mainnetAccount]?.tone ?? "muted"}>
                                            {MAINNET_STATE[m.mainnetAccount]?.label ?? m.mainnetAccount}
                                        </Badge>
                                    </td>
                                    <td className="py-1 pr-3 text-right">
                                        <SignaAmount planck={String(m.pendingPlanck)}/>
                                    </td>
                                    <td className="py-1 pr-3 text-right text-[var(--muted)]">
                                        <SignaAmount planck={String(m.paidPlanck)}/>
                                    </td>
                                    <td className="py-1 pr-3 text-right">{m.blocksMined}</td>
                                    <td className="py-1 pr-3 text-right text-[var(--muted)]">
                                        {m.blocksSkipped}
                                    </td>
                                    <td className="py-1 text-[var(--muted)]">{m.lastSkipReason ?? "—"}</td>
                                </tr>
                            ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Card>

            <Card className="mt-6">
                <CardLabel>Notification channels</CardLabel>
                {state.channels.length === 0 ? (
                    <CardSub>none configured</CardSub>
                ) : (
                    <div className="mt-2 flex flex-col gap-2">
                        {state.channels.map((c) => (
                            <div key={c.name} className="flex items-center gap-3">
                                <span className="w-20 text-[11px]">{c.name}</span>
                                <Badge tone={c.enabled ? "ok" : "muted"}>
                                    {c.enabled ? "enabled" : "muted"}
                                </Badge>
                                <span className="text-[10px] text-[var(--muted)]">
                                    {c.minSeverity === "warning" ? "all alerts" : "critical only"}
                                </span>
                                <button
                                    disabled={busy}
                                    onClick={() =>
                                        void post("notify/channel", {channel: c.name, enabled: !c.enabled})
                                    }
                                    style={btn}
                                >
                                    {c.enabled ? "Mute" : "Unmute"}
                                </button>
                                <button
                                    disabled={busy}
                                    onClick={() => void post("notify/test", {channel: c.name})}
                                    style={btn}
                                >
                                    Send test
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                {testResult && <CardSub>{testResult}</CardSub>}
                <CardSub>
                    A test bypasses both the severity filter and the mute switch — it goes straight
                    to the channel.
                </CardSub>
            </Card>

            <Card className="mt-6">
                <CardLabel>Payout simulation</CardLabel>
                <CardSub>
                    Asks a MAINNET node to build the real payout with no private key, so it comes
                    back unsigned and nothing can be spent. Rewards are real SIGNA; testnet is only
                    where the work is observed.
                </CardSub>
                <div className="mt-3">
                    <button
                        disabled={busy || !state.simulationAvailable}
                        onClick={() => void simulate()}
                        style={btn}
                    >
                        Build unsigned transaction
                    </button>
                </div>
                {simulation && (
                    <>
                        <CardSub>
                            {simulation.recipientCount} recipient(s) ·{" "}
                            <SignaAmount planck={simulation.totalPlanck}/> · fee{" "}
                            <SignaAmount planck={simulation.feePlanck}/>
                            {simulation.requiresOrdinarySend ? " · ordinary send (one recipient)" : ""}
                        </CardSub>
                        {!simulation.built && (
                            <CardSub>{simulation.reason ?? simulation.error ?? "not built"}</CardSub>
                        )}
                        {simulation.transaction && (
                            <pre
                                className="mt-3 max-h-[360px] overflow-auto p-3 text-[10px] leading-relaxed"
                                style={{
                                    background: "var(--surface-tint)",
                                    border: "1px solid var(--border)",
                                }}
                            >
{JSON.stringify(simulation.transaction.transactionJSON, null, 2)}
                            </pre>
                        )}
                    </>
                )}
            </Card>

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

const root = document.getElementById("root");
if (root) createRoot(root).render(
    <ErrorBoundary>
        <App/>
    </ErrorBoundary>,
);
