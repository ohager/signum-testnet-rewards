import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createEmailChannel } from "../../src/notify/email.ts";
import { severityAllows } from "../../src/notify/channel.ts";

// The channel calls global fetch, like every other channel here. Swapping the
// global keeps the production shape untouched and still asserts the exact
// request Resend receives — a typo in the payload is otherwise invisible until
// an alert fails to arrive.
const original = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];
let respond: () => Response;

beforeEach(() => {
  calls = [];
  respond = () => new Response("{}", { status: 200 });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = original;
});

const channel = (over: Partial<Parameters<typeof createEmailChannel>[0]> = {}) =>
  createEmailChannel({
    resendApiKey: "re_test_key",
    to: "ops@example.dev",
    from: "Rewards <alerts@example.dev>",
    minSeverity: "critical",
    ...over,
  });

const message = {
  title: "[CRITICAL] chain_fork",
  body: "Chain fork at height 980490",
  severity: "critical" as const,
};

const body = () => JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;

describe("email channel", () => {
  test("posts the alert to the Resend API", async () => {
    await channel().send(message);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.init.method).toBe("POST");
  });

  test("authorises with the API key as a bearer token", async () => {
    await channel().send(message);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("SENDS FROM THE CONFIGURED VERIFIED DOMAIN, never a built-in default", async () => {
    await channel({ from: "Alerts <noreply@my-domain.tld>" }).send(message);

    expect(body().from).toBe("Alerts <noreply@my-domain.tld>");
  });

  test("carries the alert title and body", async () => {
    await channel().send(message);

    expect(body().to).toEqual(["ops@example.dev"]);
    expect(body().subject).toBe("[CRITICAL] chain_fork");
    expect(body().text).toBe("Chain fork at height 980490");
  });

  test("A REJECTED SEND THROWS so the notifier leaves the alert queued", async () => {
    respond = () => new Response("forbidden", { status: 403 });

    await expect(channel().send(message)).rejects.toThrow("Resend responded 403");
  });

  test("a 422 from an unverified sender surfaces rather than passing silently", async () => {
    respond = () => new Response("{}", { status: 422 });

    await expect(channel().send(message)).rejects.toThrow("Resend responded 422");
  });
});

describe("email severity", () => {
  test("defaults to critical-only in the shipped configuration", () => {
    const c = channel();
    expect(severityAllows(c.minSeverity, "warning")).toBe(false);
    expect(severityAllows(c.minSeverity, "critical")).toBe(true);
  });

  test("takes warnings when configured to", () => {
    const c = channel({ minSeverity: "warning" });
    expect(severityAllows(c.minSeverity, "warning")).toBe(true);
    expect(severityAllows(c.minSeverity, "critical")).toBe(true);
  });
});
