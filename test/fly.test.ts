import { describe, expect, it } from "vitest";
import { crashReason, fly } from "../src/fly";
import { mockFetch, runCheck, type MockRoute } from "../src/testing";

type Machine = { id: string; state: string; region?: string; checks?: unknown[]; events?: unknown[] };

const exit = (exit_event: Record<string, unknown>, timestamp = 1) => ({ type: "exit", timestamp, request: { exit_event } });

/** Machines API answers with `machines`; health probes answer per pinned machine (default 200) */
function routes(machines: Machine[], extra: MockRoute[] = [], apiStatus = 200): MockRoute[] {
  return [{ url: "api.machines.dev", status: apiStatus, body: machines }, ...extra, { url: ".fly.dev", status: 200, body: "ok" }];
}

const service = (track?: Parameters<typeof fly.app>[0]["track"], app = "l21-caption") =>
  fly.app({ app, secrets: { token: "fly-token-123" }, track });

describe("fly.app", () => {
  it("derives its name, identity and description from the app", () => {
    expect(service()).toMatchObject({
      kind: "fly.app",
      name: "l21-caption",
      identity: "fly.app:l21-caption",
      slowMs: 1500,
      missing: [],
    });
    expect(fly.app({ app: "x", name: "Caption", secrets: { token: undefined } })).toMatchObject({
      name: "Caption",
      missing: ['secret "token"'],
    });
  });

  it("is not configured without a token, and calls nothing", async () => {
    const fetch = mockFetch([]);
    const result = await runCheck(fly.app({ app: "x", secrets: { token: "" } }), { fetch });
    expect(result.status).toBe("unconfigured");
    expect(fetch.calls).toHaveLength(0);
  });

  it("never probes machines that are asleep", async () => {
    const fetch = mockFetch(
      routes([
        { id: "a", state: "suspended", region: "ams" },
        { id: "b", state: "stopped", region: "ord", events: [exit({ exit_code: 0, requested_stop: true })] },
      ])
    );
    const result = await runCheck(service(), { fetch });
    expect(result).toMatchObject({ status: "sleeping", probed: false, metrics: { machines: "0/2 running" } });
    expect(result.latencyMs).toBeUndefined();
    expect(result.instances?.map((i) => [i.key, i.state, i.status])).toEqual([
      ["ams", "suspended", "sleeping"],
      ["ord", "stopped", "sleeping"],
    ]);
    // Only the control plane was called, with the token
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({
      url: "https://api.machines.dev/v1/apps/l21-caption/machines",
      headers: { authorization: "Bearer fly-token-123" },
    });
  });

  it("probes every running machine, pinned to it", async () => {
    const fetch = mockFetch(
      routes([
        { id: "m-fra", state: "started", region: "fra" },
        { id: "m-ams", state: "started", region: "ams" },
        { id: "m-sin", state: "suspended", region: "sin" },
      ])
    );
    const result = await runCheck(service({ health: "/health" }), { fetch });
    expect(result).toMatchObject({ status: "up", probed: true, metrics: { machines: "2/3 running" } });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const probes = fetch.calls.slice(1);
    expect(probes.map((call) => call.url)).toEqual(["https://l21-caption.fly.dev/health", "https://l21-caption.fly.dev/health"]);
    expect(probes.map((call) => call.headers["fly-force-instance-id"]).sort()).toEqual(["m-ams", "m-fra"]);
    expect(result.instances).toMatchObject([
      { key: "ams", region: "ams", id: "m-ams", state: "started", status: "up", httpStatus: 200 },
      { key: "fra", status: "up" },
      { key: "sin", state: "suspended", status: "sleeping" },
    ]);
  });

  it("is degraded when some regions are down, and names them", async () => {
    const fetch = mockFetch([
      {
        url: "api.machines.dev",
        body: [
          { id: "a", state: "started", region: "ams" },
          { id: "b", state: "started", region: "sin" },
          { id: "c", state: "stopped", region: "iad", events: [exit({ exit_code: 137, oom_killed: true })] },
        ],
      },
      { url: ".fly.dev", status: 200 },
    ]);
    // Make the Singapore machine fail its health probe
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get("fly-force-instance-id") === "b") return new Response("unavailable", { status: 503 });
      return fetch(input, init);
    }) as typeof globalThis.fetch;

    const result = await runCheck(service(), { fetch: failing });
    expect(result).toMatchObject({ status: "degraded", error: "2/3 machine(s) down: iad, sin" });
    expect(result.instances?.find((i) => i.key === "iad")).toMatchObject({ status: "down", error: "Out of memory" });
    expect(result.instances?.find((i) => i.key === "sin")).toMatchObject({
      status: "down",
      httpStatus: 503,
      error: "HTTP 503: unavailable",
    });
  });

  it("is down when every machine is down", async () => {
    const fetch = mockFetch(
      routes([
        { id: "a", state: "failed", region: "ams" },
        { id: "b", state: "stopped", region: "fra", events: [exit({ exit_code: 1 })] },
      ])
    );
    const result = await runCheck(service(), { fetch });
    expect(result).toMatchObject({ status: "down", error: "All 2 machine(s) down", probed: false });
    expect(fetch.calls).toHaveLength(1);
  });

  it("is down when the app has no machines or doesn't exist", async () => {
    expect(await runCheck(service(), { fetch: mockFetch(routes([])) })).toMatchObject({
      status: "down",
      error: "No machines: the app has no capacity at all",
    });
    expect(await runCheck(service(), { fetch: mockFetch(routes([], [], 404)) })).toMatchObject({
      status: "down",
      httpStatus: 404,
      error: 'App "l21-caption" not found on Fly',
    });
    // Destroyed machines don't count
    expect((await runCheck(service(), { fetch: mockFetch(routes([{ id: "a", state: "destroyed" }])) })).status).toBe("down");
  });

  it("is only degraded when the Machines API itself fails: we can't tell", async () => {
    expect(await runCheck(service(), { fetch: mockFetch(routes([], [], 500)) })).toMatchObject({
      status: "degraded",
      error: "Fly Machines API HTTP 500",
      probed: false,
    });
    const unreachable = mockFetch([{ url: "api.machines.dev", error: new TypeError("fetch failed") }]);
    expect(await runCheck(service(), { fetch: unreachable })).toMatchObject({
      status: "degraded",
      error: "Fly Machines API unreachable: fetch failed",
    });
  });

  it("keys several machines in one region distinctly", async () => {
    const fetch = mockFetch(
      routes([
        { id: "b", state: "started", region: "ams" },
        { id: "a", state: "started", region: "ams" },
      ])
    );
    const result = await runCheck(service(), { fetch });
    expect(result.instances?.map((i) => `${i.key}:${i.id}`)).toEqual(["ams:a", "ams#2:b"]);
  });

  it("flags failing Fly health checks on a running machine", async () => {
    const fetch = mockFetch(routes([{ id: "a", state: "started", region: "ams", checks: [{ name: "http", status: "critical" }] }]));
    const result = await runCheck(service(), { fetch });
    expect(result).toMatchObject({ status: "degraded", error: "Degraded in ams" });
    expect(result.instances?.[0]).toMatchObject({ status: "degraded", error: "Fly health checks failing: http" });
  });

  it("marks a slow machine degraded", async () => {
    const fetch = mockFetch([
      { url: "api.machines.dev", body: [{ id: "a", state: "started", region: "sin" }] },
      { url: ".fly.dev", status: 200, delayMs: 60 },
    ]);
    const result = await runCheck(fly.app({ app: "x", slowMs: 20, secrets: { token: "t" } }), { fetch });
    expect(result.instances?.[0]).toMatchObject({ status: "degraded" });
    expect(result.instances?.[0]?.error).toMatch(/^Slow response: \d+ ms$/);
    expect(result.status).toBe("degraded");
  });

  it("accepts any HTTP answer when asked (tunnel servers)", async () => {
    const machines = [{ id: "a", state: "started", region: "fra" }];
    const notFound: MockRoute[] = [{ url: "api.machines.dev", body: machines }, { url: ".fly.dev", status: 404 }];
    expect((await runCheck(service({ health: { anyStatus: true } }, "l21-sish"), { fetch: mockFetch(notFound) })).status).toBe("up");
    expect((await runCheck(service(undefined, "l21-sish"), { fetch: mockFetch(notFound) })).status).toBe("down");
  });

  it("can read states only, without any health probe", async () => {
    const fetch = mockFetch(routes([{ id: "a", state: "started", region: "ams" }]));
    const result = await runCheck(service({ health: false }), { fetch });
    expect(result).toMatchObject({ status: "up", metrics: { machines: "1/1 running" } });
    expect(fetch.calls).toHaveLength(1);
  });

  it("can hide the per-machine rows", async () => {
    const fetch = mockFetch(routes([{ id: "a", state: "started", region: "ams" }]));
    const result = await runCheck(service({ machines: false }), { fetch });
    expect(result.instances).toBeUndefined();
    expect(result.metrics).toEqual({ machines: "1/1 running" });
  });

  it("redacts the token from errors", async () => {
    const fetch = mockFetch([{ url: "api.machines.dev", error: new Error("bad header Bearer fly-token-123") }]);
    const result = await runCheck(service(), { fetch });
    expect(result.error).not.toContain("fly-token-123");
  });
});

describe("crashReason", () => {
  it("only reports unrequested non-zero exits and OOM kills, using the latest exit", () => {
    expect(crashReason({})).toBeUndefined();
    expect(crashReason({ events: [exit({ exit_code: 0, requested_stop: true })] })).toBeUndefined();
    expect(crashReason({ events: [exit({ exit_code: 2 })] })).toBe("Crashed (exit code 2)");
    expect(crashReason({ events: [exit({ exit_code: 1 }, 1), exit({ exit_code: 0, requested_stop: true }, 2)] })).toBeUndefined();
  });
});
