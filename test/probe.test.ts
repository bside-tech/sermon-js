import { describe, expect, it } from "vitest";
import { combine, createHttp, errorMessage, measure, normalizeReturn } from "../src/probe";
import { mockFetch } from "../src/testing";

describe("createHttp", () => {
  it("returns an up outcome with status, latency and parsed JSON", async () => {
    const fetch = mockFetch([{ url: "/ok", body: { hello: "world" } }]);
    const res = await createHttp({ timeoutMs: 1000, fetch })("https://x.test/ok");
    expect(res).toMatchObject({ ok: true, status: 200, json: { hello: "world" } });
    expect(res.outcome).toMatchObject({ status: "up", httpStatus: 200 });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("treats redirects as healthy and does not follow them", async () => {
    const fetch = mockFetch([{ url: "/moved", status: 302, headers: { location: "/elsewhere" } }]);
    const res = await createHttp({ timeoutMs: 1000, fetch })("https://x.test/moved");
    expect(res.ok).toBe(true);
    expect(fetch.calls).toHaveLength(1);
  });

  it("maps 429 to degraded and other errors to down, with a body snippet", async () => {
    const fetch = mockFetch([
      { url: "/limited", status: 429, body: "slow down" },
      { url: "/broken", status: 500, body: { error: "boom" } },
    ]);
    const http = createHttp({ timeoutMs: 1000, fetch });
    expect((await http("https://x.test/limited")).outcome).toMatchObject({
      status: "degraded",
      httpStatus: 429,
      error: "HTTP 429: slow down",
    });
    expect((await http("https://x.test/broken")).outcome).toMatchObject({
      status: "down",
      httpStatus: 500,
      error: 'HTTP 500: {"error":"boom"}',
    });
  });

  it("accepts extra healthy statuses", async () => {
    const fetch = mockFetch([{ url: "/tunnel", status: 404 }]);
    const res = await createHttp({ timeoutMs: 1000, fetch })("https://x.test/tunnel", { okStatuses: [404] });
    expect(res.ok).toBe(true);
    expect(res.outcome.status).toBe("up");
  });

  it("never throws: network failures and timeouts are down outcomes", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const fetch = mockFetch([
      { url: "/refused", error: refused },
      { url: "/slow", delayMs: 200 },
    ]);
    const http = createHttp({ timeoutMs: 30, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      // Make the mock honour abort signals like a real fetch
      return await Promise.race([
        fetch(input, init),
        new Promise<never>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        ),
      ]);
    }) as typeof globalThis.fetch });

    const failed = await http("https://x.test/refused");
    expect(failed.ok).toBe(false);
    expect(failed.status).toBeUndefined();
    expect(failed.outcome).toEqual({ status: "down", error: "fetch failed: ECONNREFUSED" });

    expect((await http("https://x.test/slow")).outcome).toEqual({ status: "down", error: "Timed out" });
  });

  it("gives undefined json for non-JSON bodies", async () => {
    const fetch = mockFetch([{ url: "/html", body: "<html>" }]);
    expect((await createHttp({ timeoutMs: 1000, fetch })("https://x.test/html")).json).toBeUndefined();
  });
});

describe("measure", () => {
  it("times a call and normalizes its return", async () => {
    expect(await measure(async () => true)).toMatchObject({ status: "up" });
    expect((await measure(async () => ({ status: "degraded", error: "meh" }))).status).toBe("degraded");
    expect((await measure(async () => undefined)).latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("turns a throw into a down outcome", async () => {
    expect(
      await measure(async () => {
        throw new Error("connection lost");
      })
    ).toMatchObject({ status: "down", error: "connection lost" });
  });
});

describe("combine", () => {
  it("keeps the worst status, slowest latency and merges the rest", () => {
    expect(
      combine([
        { status: "up", latencyMs: 800, httpStatus: 200, metrics: { videos: 40 } },
        {
          status: "degraded",
          latencyMs: 300,
          httpStatus: 200,
          error: "Storage almost full",
          usage: [{ label: "Storage", used: 95, limit: 100 }],
        },
      ])
    ).toEqual({
      status: "degraded",
      latencyMs: 800,
      httpStatus: 200,
      error: "Storage almost full",
      metrics: { videos: 40 },
      usage: [{ label: "Storage", used: 95, limit: 100 }],
      instances: undefined,
      probed: true,
    });
  });

  it("is down when any call is down", () => {
    expect(
      combine([
        { status: "down", httpStatus: 403, error: "HTTP 403" },
        { status: "up", latencyMs: 100 },
      ])
    ).toMatchObject({ status: "down", httpStatus: 403, error: "HTTP 403" });
  });
});

describe("normalizeReturn / errorMessage", () => {
  it("maps shorthand returns", () => {
    expect(normalizeReturn(true)).toEqual({ status: "up" });
    expect(normalizeReturn(undefined)).toEqual({ status: "up" });
    expect(normalizeReturn(false)).toEqual({ status: "down" });
  });

  it("names timeouts and surfaces causes", () => {
    expect(errorMessage(new DOMException("x", "TimeoutError"))).toBe("Timed out");
    expect(errorMessage(Object.assign(new Error("fetch failed"), { cause: new Error("certificate expired") }))).toBe(
      "fetch failed: certificate expired"
    );
    expect(errorMessage("plain")).toBe("plain");
  });
});
