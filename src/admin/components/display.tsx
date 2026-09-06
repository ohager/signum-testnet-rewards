/*
 * Display helpers shared by the panel and its cards.
 *
 * Extracted so a card can live in its own file without either duplicating these
 * or importing from app.tsx, which would make the dependency point the wrong way.
 */

/** Numeric ids are what the chain reports; Reed-Solomon is what a person checks. */
export function AccountId({rs, id}: { rs: string; id: string }) {
    return (
        <span>
            {rs} <span style={{color: "var(--muted)", fontSize: "0.85em"}}>({id})</span>
        </span>
    );
}

/** Signatures and block ids are 64 hex chars; only the ends identify them by eye. */
export const short = (hex: string) => (hex.length > 20 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex);

/**
 * "in 3h 20m" / "5m ago". Coarse on purpose: the next payout is a schedule, not
 * a countdown, and second-precision would imply an accuracy the runner has not
 * promised.
 */
export function relative(epochSeconds: number, nowSeconds: number): string {
    const delta = epochSeconds - nowSeconds;
    const mins = Math.floor(Math.abs(delta) / 60);
    const text = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return delta >= 0 ? `in ${text}` : `${text} ago`;
}

export const btn: React.CSSProperties = {
    border: "1px solid var(--border2)",
    color: "var(--blue2)",
    background: "var(--surface-tint)",
    padding: "8px 16px",
    fontSize: 10,
    letterSpacing: 2,
    textTransform: "uppercase",
};
