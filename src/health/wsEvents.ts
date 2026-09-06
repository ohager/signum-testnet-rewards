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
