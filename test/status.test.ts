import { describe, expect, it, vi } from "vitest";
import { custom, defineStatus, generic, group, memoryStore, type StatusStore } from "../src";
import { mockFetch } from "../src/testing";

const MINUTE = 60_000;

function setup({ store, extra = [] as ReturnType<typeof custom>[] } = {} as { store?: StatusStore; extra?: ReturnType<typeof custom>[] }) {
  let now = Date.UTC(2026, 9, 9, 12, 0);
  const clock = { advance: (ms: number) => (now += ms), now: () => now };
  const state = { apiUp: true };
  const fetch = mockFetch([{ url: "web.test", status: 200 }]);
  const status = defineStatus({
    now: clock.now,
    fetch,
    store: store ?? memoryStore({ now: clock.now }),
    services: [
      group({
        title: "Our services",
        description: "Ours",
        services: [
          generic.http({ name: "Web app", url: "https://web.test", critical: true }),
          custom({ name: "API", critical: true, check: () => state.apiUp }),
          group({ title: "Workers", services: [custom({ name: "Queue", check: () => ({ status: "degraded", error: "Backlog" }) })] }),
        ],
      }),
      custom({ name: "Billing", secrets: { apiKey: undefined }, check: () => true }),
      ...extra,
    ],
  });
  return { status, clock, state, fetch };
}

describe("defineStatus", () => {
  it("runs every service and reports the score", async () => {
    const { status } = setup();
    const report = await status.run({ trigger: "scheduled" });
    expect(report).toMatchObject({ full: true, trigger: "scheduled", label: "degraded" });
    // web (w3, 1) + api (w3, 1) + queue (w1, 0.6) = 6.6 / 7 → 94; billing is unconfigured
    expect(report.score).toBe(94);
    expect(report.results.map((r) => [r.key, r.status])).toEqual([
      ["our-services:web-app", "up"],
      ["our-services:api", "up"],
      ["our-services:workers:queue", "degraded"],
      ["billing", "unconfigured"],
    ]);
  });

  it("returns a snapshot that mirrors the configured tree", async () => {
    const { status, clock } = setup();
    expect(await status.snapshot()).toMatchObject({ score: null, label: "unknown", lastRunAt: null, nextDueAt: null });

    await status.run({ trigger: "scheduled" });
    const snapshot = await status.snapshot();
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      score: 94,
      label: "degraded",
      counts: { up: 2, degraded: 1, down: 0, sleeping: 0, unconfigured: 1 },
      lastRunAt: clock.now(),
      lastRunTrigger: "scheduled",
      lastCheckedAt: clock.now(),
      nextDueAt: clock.now() + 5 * MINUTE,
      intervalMs: 5 * MINUTE,
    });

    const [services, billing] = snapshot.tree;
    expect(services).toMatchObject({ type: "group", key: "our-services", title: "Our services", description: "Ours" });
    if (services?.type !== "group") throw new Error("expected a group");
    expect(services.children.map((child) => child.type)).toEqual(["service", "service", "group"]);
    expect(services.children[0]).toMatchObject({
      type: "service",
      key: "our-services:web-app",
      kind: "generic.http",
      name: "Web app",
      critical: true,
      configured: true,
      result: { status: "up", httpStatus: 200 },
      stats: { uptime24h: 100, samples24h: 1 },
    });
    const workers = services.children[2];
    expect(workers).toMatchObject({ type: "group", key: "our-services:workers", title: "Workers" });
    if (workers?.type !== "group") throw new Error("expected a group");
    expect(workers.children[0]).toMatchObject({ name: "Queue", result: { status: "degraded", error: "Backlog" } });

    expect(billing).toMatchObject({
      type: "service",
      key: "billing",
      configured: false,
      missing: ['secret "apiKey"'],
      result: { status: "unconfigured" },
    });
    expect((billing as { stats?: unknown }).stats).toBeUndefined();
  });

  it("runs a single service and keeps the overall score about the whole system", async () => {
    const { status, state, clock } = setup();
    await status.run({ trigger: "scheduled" });
    const fullRunAt = clock.now();
    clock.advance(MINUTE);
    state.apiUp = false;

    const report = await status.run({ keys: ["our-services:api"] });
    expect(report).toMatchObject({ full: false, trigger: "manual", label: "outage" });
    expect(report.results).toHaveLength(1);
    // web (3) + api (0) + queue (0.6) = 3.6 / 7 → 51
    expect(report.score).toBe(51);

    const snapshot = await status.snapshot();
    expect(snapshot).toMatchObject({ score: 51, label: "outage", lastRunAt: fullRunAt, lastCheckedAt: clock.now() });
    await expect(status.run({ keys: ["nope"] })).rejects.toThrow(/unknown service key/);
  });

  it("builds history bars and per-service samples", async () => {
    const { status, state, clock } = setup();
    await status.run({ trigger: "scheduled" });
    clock.advance(5 * MINUTE);
    state.apiUp = false;
    await status.run({ trigger: "scheduled" });

    const history = await status.history({ range: "24h" });
    expect(history).toMatchObject({ schemaVersion: 1, range: "24h", bucketMs: 5 * MINUTE });
    expect(history.bars).toHaveLength(288);
    expect(history.bars.at(-1)).toMatchObject({
      score: 51,
      label: "outage",
      runs: 1,
      failing: { "our-services:api": "down", "our-services:workers:queue": "degraded" },
    });
    expect(history.bars.at(-2)).toMatchObject({ score: 94, label: "degraded", runs: 1 });
    expect((await status.history({ range: "7d" })).bars).toHaveLength(168);

    const api = await status.serviceHistory("our-services:api");
    expect(api.samples.map((s) => s.status)).toEqual(["up", "down"]);
    const snapshot = await status.snapshot();
    const group = snapshot.tree[0];
    if (group?.type !== "group") throw new Error("expected a group");
    expect(group.children[1]).toMatchObject({ stats: { uptime24h: 50, samples24h: 2, lastFailure: { status: "down" } } });
    await expect(status.serviceHistory("nope")).rejects.toThrow(/unknown service key/);
  });

  it("rebuilds the page as it was during a past period", async () => {
    const { status, state, clock } = setup();
    const first = clock.now();
    await status.run({ trigger: "scheduled" });
    clock.advance(5 * MINUTE);
    state.apiUp = false;
    const second = clock.now();
    await status.run({ trigger: "scheduled" });
    clock.advance(5 * MINUTE);
    state.apiUp = true;
    await status.run({ trigger: "scheduled" });

    const flat = (tree: Awaited<ReturnType<typeof status.snapshot>>["tree"]): Array<Extract<(typeof tree)[number], { type: "service" }>> =>
      tree.flatMap((node) => (node.type === "service" ? [node] : flat(node.children)));

    // Now everything is fine again; the bar of the second run still shows the outage
    expect((await status.snapshot()).label).toBe("degraded");
    const past = await status.snapshotAt({ start: second, end: second + 5 * MINUTE - 1 });
    expect(past).toMatchObject({ score: 51, label: "outage", period: { start: second, runs: 1 }, nextDueAt: null });
    expect(past.counts).toMatchObject({ up: 1, down: 1, degraded: 1 });
    const services = Object.fromEntries(flat(past.tree).map((service) => [service.key, service]));
    expect(services["our-services:api"]).toMatchObject({ configured: true, result: { status: "down", checkedAt: second } });
    expect(services["our-services:workers:queue"]?.result).toMatchObject({ status: "degraded", error: "Backlog" });
    expect(services["our-services:web-app"]?.result).toMatchObject({ status: "up", httpStatus: 200 });
    // Statistics belong to the present, and a service without a sample has no result
    expect(services["our-services:api"]?.stats).toBeUndefined();
    expect(services["billing"]).toMatchObject({ configured: false });
    expect(services["billing"]?.result).toBeUndefined();

    // A period holding several runs keeps the worst result of each service, and the worst score
    const all = await status.snapshotAt({ start: first, end: clock.now() });
    expect(all).toMatchObject({ score: 51, label: "outage", period: { runs: 3 } });
    expect(Object.fromEntries(flat(all.tree).map((s) => [s.key, s.result?.status]))["our-services:api"]).toBe("down");

    // Nothing recorded: an empty page, not an error
    const empty = await status.snapshotAt({ start: first - 60 * MINUTE, end: first - 1 });
    expect(empty).toMatchObject({ score: null, label: "unknown", period: { runs: 0 } });
    expect(flat(empty.tree).every((service) => !service.result)).toBe(true);
  });

  it("forgets history older than the retention and services that were removed", async () => {
    const store = memoryStore();
    const first = setup({ store, extra: [custom({ name: "Legacy", check: () => true })] });
    await first.status.run();
    expect(Object.keys(await store.latest())).toContain("legacy");

    const second = setup({ store });
    second.clock.advance(8 * 24 * 60 * MINUTE);
    await second.status.run();
    expect(Object.keys(await store.latest())).not.toContain("legacy");
    expect(await store.samples("legacy", { since: 0, until: Number.MAX_SAFE_INTEGER })).toEqual([]);
    expect(await store.runs({ since: 0, until: Number.MAX_SAFE_INTEGER })).toHaveLength(1);
  });

  it("drops the stale result of a service that lost its configuration", async () => {
    const store = memoryStore();
    let apiKey: string | undefined = "key-123456";
    const make = () =>
      defineStatus({ store, services: [custom({ name: "Billing", secrets: { apiKey }, check: () => true })] });
    await make().run();
    apiKey = undefined;
    const snapshot = await make().snapshot();
    expect(snapshot.tree[0]).toMatchObject({ configured: false });
    expect((snapshot.tree[0] as { result?: unknown }).result).toBeUndefined();
    expect(snapshot.score).toBeNull();
  });

  it("redacts every configured secret from any service's error", async () => {
    const status = defineStatus({
      services: [
        custom({ name: "A", secrets: { token: "token-of-service-a" }, check: () => true }),
        custom({
          name: "B",
          check: () => {
            throw new Error("leaked token-of-service-a in logs");
          },
        }),
      ],
    });
    const { results } = await status.run();
    expect(results[1]).toMatchObject({ status: "down", error: "leaked *** in logs" });
  });

  it("gives each check a cache that survives between runs", async () => {
    const status = defineStatus({
      services: [
        custom({
          name: "Peak",
          check: async ({ cache }) => {
            const peak = Number(await cache.get("peak")) + 1;
            await cache.set("peak", String(peak), 60_000);
            return { status: "up", metrics: { peak } };
          },
        }),
      ],
    });
    await status.run();
    expect((await status.run()).results[0]).toMatchObject({ metrics: { peak: 2 } });
  });

  it("updates statistics without reading the history again on every run", async () => {
    const store = memoryStore();
    const read = vi.spyOn(store, "samples");
    const { status, clock, state } = setup({ store });
    await status.run({ trigger: "scheduled" });
    read.mockClear();
    for (let i = 0; i < 5; i++) {
      clock.advance(5 * MINUTE);
      state.apiUp = i % 2 === 0;
      await status.run({ trigger: "scheduled" });
    }
    expect(read).not.toHaveBeenCalled();

    const group = (await status.snapshot()).tree[0];
    if (group?.type !== "group") throw new Error("expected a group");
    expect(group.children[1]).toMatchObject({ stats: { uptime24h: 66.67, uptime7d: 66.67, samples24h: 6, lastFailure: { status: "down" } } });
  });

  it("works with a store that has neither lock nor cache", async () => {
    const { lock: _lock, cache: _cache, ...bare } = memoryStore();
    const status = defineStatus({ store: bare, services: [custom({ name: "A", check: () => true })] });
    await status.run({ trigger: "scheduled" });
    expect(await status.snapshot()).toMatchObject({ score: 100, lastRunTrigger: "scheduled" });
    expect(await status.lock("x", 1000)).toEqual({ ok: true });
    expect((await status.lock("x", 1000)).ok).toBe(false);
  });

  it("finds the last full run in the store when the cache is cold", async () => {
    const store = memoryStore();
    const { cache: _cache, ...withoutCache } = store;
    const services = [custom({ name: "A", check: () => true })];
    const report = await defineStatus({ store: withoutCache, services }).run({ trigger: "scheduled" });
    const fresh = defineStatus({ store: withoutCache, services });
    expect(await fresh.lastFullRun()).toEqual({ at: report.at, trigger: "scheduled" });
    expect((await fresh.snapshot()).tree[0]).toMatchObject({ stats: { uptime24h: 100 } });
  });

  it("reports configuration warnings", () => {
    const onWarning = vi.fn();
    const status = defineStatus({
      onWarning,
      services: [custom({ name: "A", check: () => true }), custom({ name: "A", check: () => true })],
    });
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(status.warnings).toHaveLength(1);
    expect(status.has("a-2")).toBe(true);
  });

  it("accepts interval, retention and scoring options", () => {
    const status = defineStatus({ services: [], interval: "1m", retention: "30d", scoring: { criticalWeight: 5 } });
    expect(status).toMatchObject({ intervalMs: 60_000, retentionMs: 30 * 24 * 60 * MINUTE });
    expect(status.scoring.criticalWeight).toBe(5);
    expect(() => defineStatus({ services: [], interval: "soon" as never })).toThrow(/Invalid duration/);
  });
});
