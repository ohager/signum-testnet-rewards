import { initialWsState, parseWsMessage, reduceWsEvent } from "./wsEvents.ts";
import type { WsState } from "./wsEvents.ts";

export interface WsMonitor {
  start: () => void;
  stop: () => void;
  getState: () => WsState;
}

/**
 * Maintains a SIP-50 WebSocket connection and folds its events into liveness state.
 *
 * Reconnects with capped exponential backoff and never throws outward: the health
 * monitor treats a dead socket as a signal (ws_degraded), not as an error, and the
 * HTTP fallback covers the gap.
 */
export function createWsMonitor(url: string, now: () => number = Date.now): WsMonitor {
  let state = initialWsState();
  let socket: WebSocket | undefined;
  let retryMs = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const scheduleReconnect = () => {
    if (stopped) return;
    timer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  };

  const connect = () => {
    if (stopped) return;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      retryMs = 1_000;
    };
    socket.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const msg = parseWsMessage(raw);
      if (msg) state = reduceWsEvent(state, msg, now());
    };
    socket.onclose = () => scheduleReconnect();
    socket.onerror = () => socket?.close();
  };

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
    getState: () => state,
  };
}
