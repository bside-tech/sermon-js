import { afterEach, describe, expect, it, vi } from "vitest";
import { thunderclap } from "../src/presets";
import { mockFetch, runCheck, type MockRoute } from "../src/testing";

const healthy: MockRoute = { url: "realtime.thunderclap.dev/health", body: { status: "ok" } };

const summary = (overrides: Record<string, unknown> = {}) => ({
  organization: { id: "org_1", slug: "acme" },
  month: "2026-11",
  period: { from: "2026-11-01T00:00:00Z", to: "2026-12-01T00:00:00Z" },
  final: false,
  plan: { id: "pro", name: "Pro", connections: 25000, messages: 25000000 },
  connections: { peak: 1200, p95: 800 },
  messages: { total: 3_000_000 },
  ...overrides,
});

describe("thunderclap", () => {
  it("checks /health only without an org key", async () => {
    const fetch = mockFetch([healthy]);
    const service = thunderclap({});
    expect(service).toMatchObject({ name: "Thunderclap", identity: "thunderclap:realtime.thunderclap.dev", missing: [] });
    const result = await runCheck(service, { fetch });
    expect(result).toMatchObject({ status: "up", httpStatus: 200 });
    expect(fetch.calls.map((call) => call.url)).toEqual(["https://realtime.thunderclap.dev/health"]);
  });

  it("is degraded on an unexpected /health answer, down when unreachable", async () => {
    const odd = await runCheck(thunderclap({}), { fetch: mockFetch([{ url: "/health", body: { status: "starting" } }]) });
    expect(odd).toMatchObject({ status: "degraded", error: "Unexpected answer from /health" });
    const failing = await runCheck(thunderclap({}), { fetch: mockFetch([{ url: "/health", status: 503 }]) });
    expect(failing.status).toBe("down");
  });

  it("follows a custom server URL", async () => {
    const fetch = mockFetch([{ url: "localhost:4000/health", body: { status: "ok" } }]);
    const service = thunderclap({ url: "http://localhost:4000/" });
    expect(service.identity).toBe("thunderclap:localhost:4000");
    expect((await runCheck(service, { fetch })).status).toBe("up");
    expect(fetch.calls[0]?.url).toBe("http://localhost:4000/health");
  });

  it("reports usage against the plan with an org key", async () => {
    const fetch = mockFetch([healthy, { url: "thunderclap.dev/api/v1/usage/summary", body: summary() }]);
    const result = await runCheck(thunderclap({ secrets: { orgApiKey: "tc_org_secret" } }), { fetch });
    const resetsAt = Date.UTC(2026, 11, 1);
    expect(result).toMatchObject({
      status: "up",
      metrics: { plan: "Pro", connectionsP95: 800 },
      usage: [
        { label: "Peak connections this month", used: 1200, limit: 25000, unit: "connections", resetsAt },
        { label: "Messages this month", used: 3_000_000, limit: 25_000_000, unit: "messages", resetsAt },
      ],
    });
    const usageCall = fetch.calls.find((call) => call.url.includes("/usage/summary"));
    expect(usageCall?.url).toBe("https://thunderclap.dev/api/v1/usage/summary");
    expect(usageCall?.headers.authorization).toBe("Bearer tc_org_secret");
  });

  it("is degraded near the plan limit, at a custom threshold", async () => {
    const near = summary({ connections: { peak: 24000, p95: 20000 } });
    const result = await runCheck(thunderclap({ secrets: { orgApiKey: "k" } }), {
      fetch: mockFetch([healthy, { url: "/usage/summary", body: near }]),
    });
    expect(result).toMatchObject({ status: "degraded", error: "Peak connections this month close to the plan limit" });

    const lowered = await runCheck(thunderclap({ secrets: { orgApiKey: "k" }, track: { usage: { warnAbovePct: 10 } } }), {
      fetch: mockFetch([healthy, { url: "/usage/summary", body: summary() }]),
    });
    expect(lowered.error).toBe("Messages this month close to the plan limit");
  });

  it("reports counts as metrics on custom plans", async () => {
    const custom = summary({ plan: { id: "custom", name: "Enterprise", connections: null, messages: null } });
    const result = await runCheck(thunderclap({ secrets: { orgApiKey: "k" } }), {
      fetch: mockFetch([healthy, { url: "/usage/summary", body: custom }]),
    });
    expect(result).toMatchObject({
      status: "up",
      metrics: { plan: "Enterprise", connectionsP95: 800, peakConnections: 1200, messages: 3_000_000 },
    });
    expect(result.usage).toBeUndefined();
  });

  it("is down when the key is rejected, and can skip usage", async () => {
    const rejected = await runCheck(thunderclap({ secrets: { orgApiKey: "bad" } }), {
      fetch: mockFetch([healthy, { url: "/usage/summary", status: 401, body: { error: "Invalid API key" } }]),
    });
    expect(rejected.status).toBe("down");

    const fetch = mockFetch([healthy]);
    await runCheck(thunderclap({ secrets: { orgApiKey: "k" }, track: { usage: false } }), { fetch });
    expect(fetch.calls).toHaveLength(1);
  });

  it("never shows the org key", async () => {
    const result = await runCheck(thunderclap({ secrets: { orgApiKey: "tc_org_leaky" } }), {
      fetch: mockFetch([healthy, { url: "/usage/summary", status: 403, body: { error: "Key tc_org_leaky lacks usage:read" } }]),
    });
    expect(JSON.stringify(result)).not.toContain("tc_org_leaky");
  });
});

/** A WebSocket that replays a scripted server: messages to send, or a close/error */
function fakeSocket(script: { messages?: unknown[]; close?: number; error?: boolean; silent?: boolean }) {
  const opened: string[] = [];
  const closed: number[] = [];
  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    constructor(readonly url: string) {
      super();
      opened.push(url);
      queueMicrotask(() => {
        if (script.silent) return;
        if (script.error) return this.dispatchEvent(new Event("error"));
        this.readyState = 1;
        for (const data of script.messages ?? []) {
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
        }
        if (script.close) this.dispatchEvent(Object.assign(new Event("close"), { code: script.close }));
      });
    }
    close(code: number) {
      closed.push(code);
      this.readyState = 3;
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return { opened, closed };
}

describe("thunderclap client connection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is up once the server accepts the connection, then closes it", async () => {
    const socket = fakeSocket({ messages: [{ event: "pusher:connection_established", data: '{"socket_id":"1.2"}' }] });
    const service = thunderclap({ key: "pk_live" });
    expect(service.description).toContain("client connection");
    const result = await runCheck(service, { fetch: mockFetch([healthy]) });
    expect(result.status).toBe("up");
    expect(socket.opened).toEqual(["wss://realtime.thunderclap.dev/app/pk_live?protocol=7&client=sermon-js&version=1"]);
    expect(socket.closed).toEqual([1000]);
  });

  it("is down when the key is refused, as an object or a string", async () => {
    fakeSocket({ messages: [{ event: "pusher:error", data: { code: 4001, message: "Unknown app key" } }] });
    const refused = await runCheck(thunderclap({ key: "pk_nope" }), { fetch: mockFetch([healthy]) });
    expect(refused).toMatchObject({ status: "down", error: "Client connection refused: Unknown app key (4001)" });

    fakeSocket({ messages: [{ event: "pusher:error", data: '{"code":4004,"message":"Over connection limit"}' }] });
    const full = await runCheck(thunderclap({ key: "pk_live" }), { fetch: mockFetch([healthy]) });
    expect(full.error).toBe("Client connection refused: Over connection limit (4004)");
  });

  it("is down when the socket fails, closes early or never answers", async () => {
    fakeSocket({ error: true });
    expect((await runCheck(thunderclap({ key: "k" }), { fetch: mockFetch([healthy]) })).error).toBe("Client connection failed");

    fakeSocket({ close: 1006 });
    expect((await runCheck(thunderclap({ key: "k" }), { fetch: mockFetch([healthy]) })).error).toBe(
      "Client connection closed before the handshake (1006)"
    );

    fakeSocket({ silent: true });
    const hung = await runCheck(thunderclap({ key: "k", timeoutMs: 50 }), { fetch: mockFetch([healthy]) });
    expect(hung.status).toBe("down");
  });

  it("uses ws:// for a plain-HTTP server", async () => {
    const socket = fakeSocket({ messages: [{ event: "pusher:connection_established" }] });
    const fetch = mockFetch([{ url: "localhost:4000/health", body: { status: "ok" } }]);
    await runCheck(thunderclap({ url: "http://localhost:4000", key: "pk_local" }), { fetch });
    expect(socket.opened[0]).toMatch(/^ws:\/\/localhost:4000\/app\/pk_local\?/);
  });

  it("is degraded where the runtime has no WebSocket", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const result = await runCheck(thunderclap({ key: "k" }), { fetch: mockFetch([healthy]) });
    expect(result).toMatchObject({ status: "degraded", error: "No WebSocket in this runtime: client connection not checked" });
  });
});
