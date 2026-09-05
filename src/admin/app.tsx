import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Card, CardLabel, CardSub } from "../ui/components/Card.tsx";
import { Badge } from "../ui/components/Badge.tsx";
import type { Tone } from "../ui/components/Badge.tsx";
import { SignaAmount } from "../ui/components/SignaAmount.tsx";

/** The token is supplied via the URL once, then kept in memory only. */
const token = new URLSearchParams(location.search).get("token") ?? "";
const api = (path: string, init?: RequestInit) =>
  fetch(`/api/${path}`, { ...init, headers: { "x-admin-token": token } });

interface State {
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

  const tone: Tone =
    state.health?.overall === "critical"
      ? "crit"
      : state.health?.overall === "warning"
        ? "warn"
        : "ok";

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

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
