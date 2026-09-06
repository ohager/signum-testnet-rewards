import {useEffect, useState} from "react";
import {createRoot} from "react-dom/client";
import {Card, CardLabel, CardSub} from "./components/Card";
import {Badge, type Tone} from "./components/Badge";
import {SignaAmount} from "./components/SignaAmount";

/** The token is supplied via the URL once, then kept in memory only. */
const token = new URLSearchParams(location.search).get("token") ?? "";
const api = (path: string, init?: RequestInit) =>
    fetch(`/api/${path}`, {...init, headers: {"x-admin-token": token}});

interface MinerRow {
    accountId: string;
    accountRS: string;
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
    payoutDue: boolean;
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
function AccountId({rs, id}: { rs: string; id: string }) {
    return (
        <span>
            {rs} <span style={{color: "var(--muted)", fontSize: "0.85em"}}>({id})</span>
        </span>
    );
}

/** Signatures and block ids are 64 hex chars; only the ends identify them by eye. */
const short = (hex: string) => (hex.length > 20 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex);

/**
 * "in 3h 20m" / "5m ago". Coarse on purpose: the next payout is a schedule, not
 * a countdown, and second-precision would imply an accuracy the runner has not
 * promised.
 */
function relative(epochSeconds: number, nowSeconds: number): string {
    const delta = epochSeconds - nowSeconds;
    const mins = Math.floor(Math.abs(delta) / 60);
    const text = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return delta >= 0 ? `in ${text}` : `${text} ago`;
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

function App() {
    const [state, setState] = useState<State | undefined>();
    const [busy, setBusy] = useState(false);
    const [testResult, setTestResult] = useState<string | undefined>();
    const [simulation, setSimulation] = useState<Simulation | undefined>();

    const refresh = async () => setState((await (await api("state")).json()) as State);
    useEffect(() => {
        void refresh();
        const t = setInterval(() => void refresh(), 5000);
        return () => clearInterval(t);
    }, []);

    const act = async (path: string) => {
        setBusy(true);
        await api(path, {method: "POST"});
        await refresh();
        setBusy(false);
    };

    const post = async (path: string, payload: unknown) => {
        setBusy(true);
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
        setBusy(false);
    };

    const simulate = async () => {
        setBusy(true);
        setSimulation(undefined);
        const res = await api("payout/simulate", {method: "POST"});
        setSimulation((await res.json()) as Simulation);
        setBusy(false);
    };

    if (!state) return <main className="p-8 text-[var(--muted)]">Loading…</main>;

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
            <h1
                className="mb-6 text-[18px] uppercase tracking-[6px]"
                style={{fontFamily: "var(--font-display)", color: "var(--blue2)"}}
            >
                Testnet Rewards — Admin
            </h1>

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
                    ) : (
                        <>
                            <p className="text-[22px]" style={{fontFamily: "var(--font-display)"}}>
                                {status.payoutDue ? "due now" : relative(status.nextPayoutAt, now)}
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
                    Asks the node to build the real transaction with no private key, so it is
                    returned unsigned and nothing can be spent.
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
if (root) createRoot(root).render(<App/>);
