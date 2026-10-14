import { describe, expect, it } from "vitest";
import { custom, defineStatus, generic, group } from "../src";
import { createStatusHandler } from "../src/api";
import { componentStatus } from "../src/visibility";
import { mockFetch } from "../src/testing";

describe("componentStatus", () => {
  const s = (status: string, critical = false) => ({ status: status as "up", critical });
  it("summarizes a group as one component", () => {
    expect(componentStatus([s("up"), s("sleeping")])).toBe("up");
    expect(componentStatus([s("up"), s("degraded")])).toBe("degraded");
    // A non-critical service down is a partial problem, a critical one is an outage
    expect(componentStatus([s("up"), s("down")])).toBe("degraded");
    expect(componentStatus([s("up"), s("down", true)])).toBe("down");
    expect(componentStatus([s("down"), s("down"), s("unconfigured")])).toBe("down");
    expect(componentStatus([s("unconfigured")])).toBe("unconfigured");
    expect(componentStatus([])).toBe("unconfigured");
  });
});

const SECRET_ERROR = "HTTP 500: vendor-x exploded at internal-host-42";

function setup({ access }: { access?: (request: Request) => { full: boolean; name?: string } } = {}) {
  const status = defineStatus({
    fetch: mockFetch([{ url: "web.test", status: 200 }]),
    services: [
      group({
        title: "Our services",
        description: "Things we run",
        services: [
          generic.http({ name: "Web app", url: "https://web.test", critical: true }),
          custom({ name: "Billing engine", check: () => ({ status: "down", error: SECRET_ERROR, latencyMs: 40 }) }),
        ],
      }),
      group({
        title: "External providers",
        services: [
          group({
            title: "AI",
            services: [custom({ name: "VendorX", critical: true, check: () => ({ status: "up", metrics: { balance: "12 USD" } }) })],
          }),
        ],
      }),
      custom({ name: "Loose one", check: () => ({ status: "degraded", error: "slow" }) }),
    ],
  });
  const handler = createStatusHandler(status, {
    access,
    signInUrl: (request) => `https://auth.test/signin?callbackUrl=${encodeURIComponent(new URL(request.url).origin)}`,
  });
  const call = (path: string, init?: RequestInit) => handler(new Request(`https://status.test/api${path}`, init));
  return { status, call };
}

const staff = (request: Request) =>
  request.headers.get("cookie")?.includes("session=staff") ? { full: true, name: "ana@line.test" } : { full: false };

describe("public and full views", () => {
  it("serves only the essentials to anonymous viewers, cacheable by a CDN", async () => {
    const { call, status } = setup({ access: staff });
    await status.run();
    const res = await call("/status");
    expect(res.headers.get("cdn-cache-control")).toContain("max-age=");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ view: "public", score: expect.any(Number) });
    expect(body.tree.map((row: { name: string; result?: { status: string } }) => [row.name, row.result?.status])).toEqual([
      ["Our services", "degraded"],
      ["External providers", "up"],
      ["Other services", "degraded"],
    ]);
    expect(body.counts).toMatchObject({ up: 1, degraded: 2 });
    // Nothing about individual services: names, errors, metrics, timings
    for (const hidden of ["Web app", "Billing engine", "VendorX", "Loose one", SECRET_ERROR, "12 USD", "latencyMs", "stats", "AI"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("never computes the public view from cookies, so a cached response can't leak", async () => {
    const { call, status } = setup({ access: staff });
    await status.run();
    const res = await call("/status", { headers: { cookie: "session=staff" } });
    expect((await res.json()).view).toBe("public");
  });

  it("serves everything to an allowed viewer who asks for it, privately", async () => {
    const { call, status } = setup({ access: staff });
    await status.run();
    const res = await call("/status?view=full", { headers: { cookie: "session=staff" } });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cdn-cache-control")).toBeNull();
    const text = await res.text();
    expect(text).toContain("Billing engine");
    expect(text).toContain(SECRET_ERROR);

    // Asking without the right session gives the public view, still private
    const denied = await call("/status?view=full", { headers: { cookie: "session=guest" } });
    expect(denied.headers.get("cache-control")).toBe("private, no-store");
    expect((await denied.json()).view).toBe("public");
  });

  it("tells the page who is looking", async () => {
    const { call } = setup({ access: staff });
    const anonymous = await call("/viewer");
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    expect(await anonymous.json()).toEqual({
      view: "public",
      signInUrl: "https://auth.test/signin?callbackUrl=https%3A%2F%2Fstatus.test",
    });
    expect(await (await call("/viewer", { headers: { cookie: "session=staff" } })).json()).toEqual({
      view: "full",
      name: "ana@line.test",
    });
  });

  it("names failing components, not services, in the public history", async () => {
    const { call, status } = setup({ access: staff });
    await status.run();
    const publicBars = (await (await call("/history")).json()).bars;
    expect(publicBars.at(-1).failing).toEqual({ "our-services": "degraded", ungrouped: "degraded" });
    const fullBars = (await (await call("/history?view=full", { headers: { cookie: "session=staff" } })).json()).bars;
    expect(Object.keys(fullBars.at(-1).failing).sort()).toEqual(["loose-one", "our-services:billing-engine"]);
  });

  it("keeps past periods at the same level of detail", async () => {
    const { call, status } = setup({ access: staff });
    const start = Date.now() - 1000;
    await status.run();
    const query = `/status/at?start=${start}&end=${Date.now() + 1000}`;
    const text = await (await call(query)).text();
    expect(JSON.parse(text)).toMatchObject({ view: "public", period: { runs: 1 } });
    expect(text).not.toContain(SECRET_ERROR);
    expect(await (await call(`${query}&view=full`, { headers: { cookie: "session=staff" } })).text()).toContain(SECRET_ERROR);
  });

  it("only lets allowed viewers run checks or read a service's history", async () => {
    const { call, status } = setup({ access: staff });
    await status.run();
    const key = encodeURIComponent("our-services:web-app");
    expect((await call("/run", { method: "POST" })).status).toBe(403);
    expect((await call(`/run/${key}`, { method: "POST" })).status).toBe(403);
    expect((await call(`/run/${key}?view=full`, { method: "POST", headers: { cookie: "session=guest" } })).status).toBe(403);
    expect((await call(`/services/${key}/history`)).status).toBe(403);

    const run = await call(`/run/${key}?view=full`, { method: "POST", headers: { cookie: "session=staff" } });
    expect(run.status).toBe(200);
    expect(run.headers.get("cache-control")).toBe("private, no-store");
    expect((await call(`/services/${key}/history?view=full`, { headers: { cookie: "session=staff" } })).status).toBe(200);
  });

  it("falls back to the public view when the access check fails", async () => {
    const errors: string[] = [];
    const status = defineStatus({ services: [custom({ name: "API", check: () => true })] });
    const handler = createStatusHandler(status, {
      access: () => {
        throw new Error("auth server down");
      },
      onError: ({ message }) => errors.push(message),
    });
    const res = await handler(new Request("https://s.test/api/status?view=full"));
    expect(res.status).toBe(200);
    expect((await res.json()).view).toBe("public");
    expect(errors[0]).toContain("auth server down");
  });

  it("shows everything to everyone without an access check, as before", async () => {
    const { call, status } = setup();
    await status.run();
    expect(await (await call("/viewer")).json()).toMatchObject({ view: "full" });
    const res = await call("/status");
    expect(res.headers.get("cdn-cache-control")).toContain("max-age=");
    expect(await res.text()).toContain("Billing engine");
    expect((await call("/run", { method: "POST" })).status).toBe(200);
  });
});
