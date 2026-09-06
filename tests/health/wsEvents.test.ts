import { test, expect, describe } from "bun:test";
import { initialWsState, reduceWsEvent, parseWsMessage } from "../../src/health/wsEvents.ts";

const NOW = 1_800_000_000_000;

describe("parseWsMessage", () => {
  test("parses a well-formed SIP-50 envelope", () => {
    expect(parseWsMessage('{"e":"HEARTBEAT"}')).toEqual({ e: "HEARTBEAT", p: undefined });
  });
  test("parses an envelope with a payload", () => {
    const msg = parseWsMessage('{"e":"BLOCK_PUSHED","p":{"height":1234}}');
    expect(msg?.e).toBe("BLOCK_PUSHED");
    expect(msg?.p).toEqual({ height: 1234 });
  });
  test("returns undefined for malformed JSON rather than throwing", () => {
    expect(parseWsMessage("not json")).toBeUndefined();
  });
  test("returns undefined when the event field is missing", () => {
    expect(parseWsMessage('{"p":{"height":1}}')).toBeUndefined();
  });
  test("ignores an unknown event type", () => {
    expect(parseWsMessage('{"e":"SOMETHING_NEW"}')).toBeUndefined();
  });
});

describe("reduceWsEvent", () => {
  test("HEARTBEAT records liveness without touching block state", () => {
    const state = reduceWsEvent(initialWsState(), { e: "HEARTBEAT" }, NOW);
    expect(state.lastHeartbeatAtMs).toBe(NOW);
    expect(state.lastBlockAtMs).toBeUndefined();
  });
  test("BLOCK_PUSHED records both a block and liveness", () => {
    const state = reduceWsEvent(initialWsState(), { e: "BLOCK_PUSHED", p: { height: 500 } }, NOW);
    expect(state.lastBlockAtMs).toBe(NOW);
    expect(state.lastHeartbeatAtMs).toBe(NOW);
    expect(state.localHeight).toBe(500);
  });
  test("CONNECTED records both heights for the sync-lag check", () => {
    const state = reduceWsEvent(initialWsState(),
      { e: "CONNECTED", p: { localHeight: 990, globalHeight: 1000 } }, NOW);
    expect(state.localHeight).toBe(990);
    expect(state.globalHeight).toBe(1000);
    expect(state.lastHeartbeatAtMs).toBe(NOW);
  });
  test("a BLOCK_PUSHED without a usable height still records the timing", () => {
    const state = reduceWsEvent(initialWsState(), { e: "BLOCK_PUSHED", p: {} }, NOW);
    expect(state.lastBlockAtMs).toBe(NOW);
    expect(state.localHeight).toBeUndefined();
  });
  test("PENDING_TRANSACTIONS_ADDED counts as liveness but not as a block", () => {
    const state = reduceWsEvent(initialWsState(), { e: "PENDING_TRANSACTIONS_ADDED" }, NOW);
    expect(state.lastHeartbeatAtMs).toBe(NOW);
    expect(state.lastBlockAtMs).toBeUndefined();
  });
  test("PURITY: reducing returns a new state and leaves the old one untouched", () => {
    const before = initialWsState();
    const after = reduceWsEvent(before, { e: "HEARTBEAT" }, NOW);
    expect(before.lastHeartbeatAtMs).toBeUndefined();
    expect(after).not.toBe(before);
  });
});
