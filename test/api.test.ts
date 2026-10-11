import { afterEach, describe, expect, it, vi } from "vitest";
import { custom, defineStatus, group, memoryStore } from "../src";
import { createStatusHandler, toNodeListener, type StatusHandlerOptions } from "../src/api";

const MINUTE = 60_000;

function setup(options: StatusHandlerOptions = {}) {
  const check = vi.fn(async () => true);
  const status = defineStatus({
    store: memoryStore(),
    services: [
      group({ title: "Services", services: [custom({ name: "API", check }), custom({ name: "Web", check: () => true })] }),
    ],
  });
  const handler = createStatusHandler(status, options);
  const call = (path: string, init?: RequestInit) => handler(new Request(`https://status.test${path}`, init));
  return { status, handler, call, check };
}

describe("createStatusHandler", () => {
  afterEach(() => vi.useRealTimers());

  it("serves the snapshot with CDN-only caching", async () => {
    const { call, status } = setup();
    await status.run();
    const res = await call("/api/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("cdn-cache-control")).toBe("max-age=10, stale-while-revalidate=30");
    expect(await res.json()).toMatchObject({ schemaVersion: 1, score: 100, tree: [{ type: "group", title: "Services" }] });
  });

  it("serves score history and per-service history", async () => {
    const { call, status } = setup({ cache: { history: 120 } });
    await status.run();
    const history = await call("/api/history?range=7d");
    expect(history.headers.get("cdn-cache-control")).toBe("max-age=120, stale-while-revalidate=360");
    expect(await history.json()).toMatchObject({ range: "7d", bars: expect.any(Array) });
    expect(((await (await call("/api/history?range=nope")).json()) as { range: string }).range).toBe("24h");

    // Keys contain ":" and may be URL-encoded
    const service = await call(`/api/services/${encodeURIComponent("services:api")}/history`);
    expect(await service.json()).toMatchObject({ key: "services:api", samples: [{ status: "up" }] });
    expect((await call("/api/services/services:web/history")).status).toBe(200);
    expect((await call("/api/services/nope/history")).status).toBe(404);
  });

  it("can disable shared caching", async () => {
    const { call } = setup({ cache: false });
    const res = await call("/api/status");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBeNull();
  });

  it("runs everything on demand, once per rate-limit window", async () => {
    const { call, check } = setup();
    const first = await call("/api/run", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ score: 100, lastRunTrigger: "manual" });

    const second = await call("/api/run", { method: "POST" });
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await second.json()).toMatchObject({ error: "A full run happened recently", retryAfter: 60 });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("runs one service on demand, rate limited per service", async () => {
    const { call, check } = setup({ rateLimits: { runOne: "30s" } });
    expect((await call("/api/run/services:api", { method: "POST" })).status).toBe(200);
    const again = await call("/api/run/services:api", { method: "POST" });
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ retryAfter: 30 });
    // Another service has its own window
    expect((await call("/api/run/services:web", { method: "POST" })).status).toBe(200);
    expect((await call("/api/run/nope", { method: "POST" })).status).toBe(404);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("ticks without a secret, only when due", async () => {
    const { call, check } = setup();
    const first = await call("/api/tick");
    expect(await first.json()).toMatchObject({
      ran: true,
      score: 100,
      statuses: { "services:api": "up", "services:web": "up" },
    });
    expect(await (await call("/api/tick", { method: "POST" })).json()).toMatchObject({ ran: false, reason: "not-due" });
    // Nobody can force a run without the secret
    expect(await (await call("/api/tick?force=1")).json()).toMatchObject({ ran: false });
    expect(check).toHaveBeenCalledTimes(1);
    // A scheduled run also starts the public rate-limit window
    expect((await call("/api/run", { method: "POST" })).status).toBe(429);
  });

  it("requires the secret on /tick when one is configured", async () => {
    const { call, check } = setup({ secret: "s3cret-value" });
    expect((await call("/api/tick")).status).toBe(401);
    expect((await call("/api/tick", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call("/api/tick", { headers: { authorization: "Bearer undefined" } })).status).toBe(401);
    expect(check).not.toHaveBeenCalled();

    expect((await call("/api/tick", { headers: { authorization: "Bearer s3cret-value" } })).status).toBe(200);
    expect(await (await call("/api/tick", { headers: { "x-sermon-secret": "s3cret-value" } })).json()).toMatchObject({
      ran: false,
    });
    expect(await (await call("/api/tick?key=s3cret-value&force=1")).json()).toMatchObject({ ran: true });
    expect(check).toHaveBeenCalledTimes(2);
    // The old path still works for schedulers set up before
    expect((await call("/api/cron", { headers: { authorization: "Bearer s3cret-value" } })).status).toBe(200);
  });

  it("refreshes stale data on read through waitUntil, without delaying the response", async () => {
    const pending: Promise<unknown>[] = [];
    const { handler, check } = setup({ refreshOnRead: true });
    const res = await handler(new Request("https://status.test/api/status"), { waitUntil: (p) => pending.push(p) });
    // Answered from what was known (nothing yet) while the run continues in the background
    expect(await res.json()).toMatchObject({ score: null });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(check).toHaveBeenCalledTimes(1);

    // Fresh now: no second refresh
    await handler(new Request("https://status.test/api/status"), { waitUntil: (p) => pending.push(p) });
    expect(pending).toHaveLength(1);
  });

  it("waits for the refresh when there is no waitUntil", async () => {
    const { call, check } = setup({ refreshOnRead: true });
    expect(await (await call("/api/status")).json()).toMatchObject({ score: 100, lastRunTrigger: "scheduled" });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("refreshes again once the interval has passed", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 9, 12, 0) });
    const { call, check } = setup({ refreshOnRead: true });
    await call("/api/status");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await call("/api/status");
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    await call("/api/status");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does not refresh on read unless asked", async () => {
    const { call, check } = setup();
    await call("/api/status");
    expect(check).not.toHaveBeenCalled();
  });

  it("mounts under any base path", async () => {
    const { call } = setup({ basePath: "/internal/status-api/" });
    expect((await call("/internal/status-api/status")).status).toBe(200);
    expect((await call("/api/status")).status).toBe(404);
    const root = setup({ basePath: "/" });
    expect((await root.call("/status")).status).toBe(200);
  });

  it("answers 404 for unknown routes and wrong methods", async () => {
    const { call } = setup();
    expect((await call("/api/nope")).status).toBe(404);
    expect((await call("/api/run")).status).toBe(404);
    expect((await call("/api/status", { method: "POST" })).status).toBe(404);
    expect((await call("/api/status/extra")).status).toBe(404);
  });

  it("supports CORS when enabled", async () => {
    const { call } = setup({ cors: true });
    const preflight = await call("/api/run", { method: "OPTIONS", headers: { origin: "https://app.test" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect((await call("/api/status")).headers.get("access-control-allow-origin")).toBe("*");
    const none = await setup().call("/api/status");
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
    const fixed = await setup({ cors: "https://only.test" }).call("/api/status");
    expect(fixed.headers.get("access-control-allow-origin")).toBe("https://only.test");
  });

  it("hides internal errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = memoryStore();
    store.latest = async () => {
      throw new Error("connection string with password");
    };
    const status = defineStatus({ store, services: [custom({ name: "A", check: () => true })] });
    const res = await createStatusHandler(status)(new Request("https://status.test/api/status"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error" });
    error.mockRestore();
  });
});

describe("toNodeListener", () => {
  it("bridges Node requests and responses", async () => {
    const { handler } = setup();
    const listener = toNodeListener(handler);
    const run = async (method: string, url: string) => {
      const headers: Record<string, string> = {};
      const res = {
        statusCode: 0,
        body: "",
        setHeader: (name: string, value: string) => (headers[name] = value),
        end(body?: string) {
          this.body = body ?? "";
        },
      };
      const req = {
        method,
        url,
        headers: { host: "localhost:3000" },
        async *[Symbol.asyncIterator]() {
          // no body
        },
      };
      await listener(req as never, res);
      return { ...res, headers };
    };

    const tick = await run("POST", "/api/tick");
    expect(tick.statusCode).toBe(200);
    expect(JSON.parse(tick.body)).toMatchObject({ ran: true });
    const status = await run("GET", "/api/status");
    expect(status.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(status.body)).toMatchObject({ score: 100 });
    expect((await run("GET", "/api/nope")).statusCode).toBe(404);
  });
});
