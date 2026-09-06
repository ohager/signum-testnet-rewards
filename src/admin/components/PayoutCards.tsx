import {Card, CardLabel, CardSub} from "./Card";
import {Badge, type Tone} from "./Badge";
import {SignaAmount} from "./SignaAmount";
import {AccountId, short, relative, btn} from "./display";

export interface PayoutAccountRow {
    accountId: string;
    accountRS: string;
    balancePlanck: string | null;
    existsOnChain: boolean | null;
    checkedAt: number | null;
    error: string | null;
}

export interface LiveBatch {
    id: number;
    status: "claimed" | "pending" | "confirming" | "confirmed" | "failed";
    recipientCount: number | null;
    totalPlanck: string | null;
    txId: string | null;
    broadcastHost: string | null;
    broadcastAt: number | null;
    confirmedAt: number | null;
    deadlineAt: number | null;
    attemptCount: number;
    lastError: string | null;
}

export interface PayoutState {
    releaseMode: "armed" | "auto" | null;
    releaseAvailable: boolean;
    /** The batch still owed work, or null when the runner is idle. */
    live: LiveBatch | null;
}

export interface DryRunView {
    totalPlanck: string;
    wouldSend: boolean;
    recipients: unknown[];
}

const BATCH_TONE: Record<LiveBatch["status"], Tone> = {
    claimed: "warn",
    pending: "warn",
    confirming: "ok",
    confirmed: "ok",
    failed: "crit",
};

/** What each status means, in the terms an operator actually needs. */
const BATCH_MEANING: Record<LiveBatch["status"], string> = {
    claimed: "accruals are stamped but no transaction is recorded — the reconciler owns this",
    pending: "accepted into the mempool, not yet in a block",
    confirming: "in a block, waiting for the required depth",
    confirmed: "settled",
    failed: "released — the accruals are back in the pool for the next cycle",
};

/**
 * The payout release control.
 *
 * `armed` is the default and this button is the ONLY thing that sends in that
 * mode. The approved total travels with the request so the runner can refuse if
 * a block landed between this render and the click: otherwise an operator
 * approves one amount and a different one goes out.
 */
export function PayoutReleaseCard(
    {payout, dryRun, busy, confirming, result, onArm, onCancel, onRelease, now}: {
        payout: PayoutState;
        dryRun: DryRunView;
        busy: boolean;
        confirming: boolean;
        result: string | undefined;
        onArm: () => void;
        onCancel: () => void;
        onRelease: (expectedTotalPlanck: string) => void;
        now: number;
    },
) {
    const live = payout.live;
    const canRelease =
        payout.releaseAvailable && !live && dryRun.wouldSend && dryRun.recipients.length > 0;

    return (
        <Card>
            <CardLabel>Payout release</CardLabel>

            <div className="mb-2 flex flex-wrap gap-2">
                {payout.releaseMode === null ? (
                    <Badge tone="muted">no runner</Badge>
                ) : (
                    <Badge tone={payout.releaseMode === "auto" ? "warn" : "ok"}>
                        {payout.releaseMode === "auto" ? "automatic" : "armed"}
                    </Badge>
                )}
                {live && <Badge tone={BATCH_TONE[live.status]}>{live.status}</Badge>}
            </div>

            {live ? (
                <>
                    <p className="text-[22px]" style={{fontFamily: "var(--font-display)"}}>
                        <SignaAmount planck={live.totalPlanck ?? "0"}/>
                    </p>
                    <CardSub>
                        batch #{live.id} · {live.recipientCount ?? 0} recipients
                    </CardSub>
                    <CardSub>{BATCH_MEANING[live.status]}</CardSub>
                    {live.txId && (
                        <CardSub>
                            tx {short(live.txId)}
                            {live.broadcastHost && ` via ${live.broadcastHost}`}
                        </CardSub>
                    )}
                    {live.deadlineAt !== null && live.status !== "confirming" && (
                        <CardSub>
                            {live.deadlineAt > now
                                ? `deadline ${relative(live.deadlineAt, now)} — released for retry after it passes`
                                : "deadline passed — will be released on the next check"}
                        </CardSub>
                    )}
                    {live.attemptCount > 0 && (
                        <CardSub>
                            {live.attemptCount} failed attempt{live.attemptCount === 1 ? "" : "s"}
                            {live.lastError && `: ${live.lastError}`}
                        </CardSub>
                    )}
                    <CardSub>
                        No new batch can start while this one is unresolved.
                    </CardSub>
                    {result && <CardSub>{result}</CardSub>}
                </>
            ) : (
                <>
                    <p className="text-[26px]" style={{fontFamily: "var(--font-display)"}}>
                        <SignaAmount planck={dryRun.totalPlanck}/>
                    </p>
                    <CardSub>
                        {dryRun.recipients.length} recipients ·{" "}
                        {dryRun.wouldSend ? "ready to send" : "blocked"}
                    </CardSub>
                    {!payout.releaseAvailable && (
                        <CardSub>No payout runner is configured, so nothing can be released.</CardSub>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                        {confirming ? (
                            <>
                                <button
                                    disabled={busy}
                                    onClick={() => onRelease(dryRun.totalPlanck)}
                                    style={{...btn, color: "var(--mag)", borderColor: "var(--mag)"}}
                                >
                                    Confirm — send now
                                </button>
                                <button disabled={busy} onClick={onCancel} style={btn}>
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                disabled={busy || !canRelease}
                                onClick={onArm}
                                style={{...btn, opacity: canRelease && !busy ? 1 : 0.4}}
                            >
                                Release batch
                            </button>
                        )}
                    </div>
                    <CardSub>
                        {confirming
                            ? "This signs and broadcasts immediately. Real SIGNA leaves the payout account on mainnet and cannot be recalled."
                            : "Two steps, because a release cannot be undone."}
                    </CardSub>
                    {result && <CardSub>{result}</CardSub>}
                </>
            )}
        </Card>
    );
}
/**
 * The account the money leaves FROM, and whether it can cover what we are about
 * to send.
 *
 * Two things are deliberately kept apart here. The address is derived locally
 * from the payout public key, so it is shown unconditionally — "which account
 * do we pay from" has an answer even with every mainnet node unreachable. The
 * balance is a mainnet reading and may be missing, ageing or stale, and says so.
 *
 * MAINNET, throughout. Every other account on this panel is a testnet forger;
 * this one is where real SIGNA is spent from, which is why the address is
 * rendered with its `S-` prefix and labelled.
 */
export function PayoutAccountCard(
    {account, dueTotalPlanck, now}: {
        account: PayoutAccountRow | null;
        dueTotalPlanck: string;
        now: number;
    },
) {
    if (!account) {
        return (
            <Card>
                <CardLabel>Payout account</CardLabel>
                <Badge tone="warn">not configured</Badge>
                <CardSub>
                    PAYOUT_ACCOUNT_SEED is unset, so no account is derived and nothing can be
                    signed.
                </CardSub>
            </Card>
        );
    }

    const balance = account.balancePlanck === null ? null : BigInt(account.balancePlanck);
    const due = BigInt(dueTotalPlanck);
    // Excludes the network fee, so "covers" is a necessary condition and not a
    // sufficient one. Overstating it would be worse than leaving the fee out.
    const shortfall = balance !== null && due > 0n && balance < due ? due - balance : null;

    return (
        <Card>
            <CardLabel>Payout account — mainnet</CardLabel>

            {balance === null ? (
                <p className="text-[22px]" style={{fontFamily: "var(--font-display)"}}>
                    <span style={{color: "var(--muted)"}}>checking…</span>
                </p>
            ) : (
                <p className="text-[26px]" style={{fontFamily: "var(--font-display)"}}>
                    <SignaAmount planck={String(balance)}/>
                </p>
            )}

            <div className="mt-1 flex flex-wrap gap-2">
                {account.existsOnChain === false && <Badge tone="crit">not on chain</Badge>}
                {shortfall !== null && <Badge tone="crit">short of next batch</Badge>}
                {account.error !== null && <Badge tone="warn">balance stale</Badge>}
            </div>

            <CardSub>
                <AccountId rs={account.accountRS} id={account.accountId}/>
            </CardSub>

            {shortfall !== null && (
                <CardSub>
                    short by <SignaAmount planck={String(shortfall)}/> of the{" "}
                    <SignaAmount planck={dueTotalPlanck}/> dry run, before fees
                </CardSub>
            )}

            {account.existsOnChain === false && (
                <CardSub>
                    mainnet has no such account: it has never received anything, so it holds
                    nothing and cannot pay
                </CardSub>
            )}

            {account.error !== null && <CardSub>last lookup failed: {account.error}</CardSub>}

            <CardSub>
                {account.checkedAt === null
                    ? "no successful balance lookup yet"
                    : `balance read ${relative(account.checkedAt, now)}`}
            </CardSub>
        </Card>
    );
}
