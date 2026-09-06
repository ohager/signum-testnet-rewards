export type Tone = "ok" | "warn" | "crit" | "muted";

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
