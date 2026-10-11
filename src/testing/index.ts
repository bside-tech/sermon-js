import { resolveTree, type ServiceDefinition } from "../config";
import { runService } from "../runner";
import { collectSecretValues } from "../sanitize";
import type { CheckSample, RunSummary, StatusStore } from "../store";
import type { CheckResult } from "../types";

const summary = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  at: 1_000,
  trigger: "scheduled",
  full: true,
  score: 100,
  label: "operational",
  failing: {},
  ...overrides,
});

const result = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  key: "api",
  status: "up",
  checkedAt: 1_000,
  probed: true,
  latencyMs: 120,
  ...overrides,
});

const sample = (overrides: Partial<CheckSample> = {}): CheckSample => ({
  key: "api",
  at: 1_000,
  status: "up",
  latencyMs: 120,
  ...overrides,
});

/** Stores may drop `undefined` fields or not: compare what matters */
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The few test-runner functions the suite needs. Vitest and Jest both fit. */
export type TestHarness = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect: (actual: any) => any;
};

function resolveHarness(harness?: TestHarness): TestHarness {
  if (harness) return harness;
  const globals = globalThis as Partial<TestHarness>;
  if (globals.describe && globals.it && globals.expect) {
    return { describe: globals.describe, it: globals.it, expect: globals.expect };
  }
  throw new Error(
    "sermon-js/testing: pass your test runner's { describe, it, expect } as the third argument " +
      "(or enable the runner's globals)."
  );
}

/**
 * The contract every `StatusStore` must honour. Call it from a test file of your adapter:
 *
 * ```ts
 * import { describe, expect, it } from "vitest";            // or Jest's globals
 * import { runStoreConformance } from "sermon-js/testing";
 * runStoreConformance("my store", () => myStore({ … }), { describe, it, expect });
 * ```
 *
 * `createStore` must return a fresh, empty store each time.
 */
export function runStoreConformance(
  name: string,
  createStore: () => StatusStore | Promise<StatusStore>,
  harness?: TestHarness
) {
  const { describe, it, expect } = resolveHarness(harness);
  describe(`${name}: StatusStore conformance`, () => {
    it("starts empty", async () => {
      const store = await createStore();
      expect(await store.latest()).toEqual({});
      expect(await store.runs({ since: 0, until: 10_000 })).toEqual([]);
      expect(await store.samples("api", { since: 0, until: 10_000 })).toEqual([]);
    });

    it("keeps the latest result of each service, with all its fields", async () => {
      const store = await createStore();
      const rich = result({
        key: "fly",
        status: "degraded",
        httpStatus: 200,
        error: "1/2 machine(s) down: sin",
        metrics: { machines: "1/2 running", count: 2 },
        usage: [{ label: "Requests", used: 15, limit: 100, unit: "requests", resetsAt: 9_999 }],
        instances: [
          { key: "ams", region: "ams", id: "m1", state: "started", status: "up", latencyMs: 80, httpStatus: 200 },
          { key: "sin", region: "sin", id: "m2", state: "stopped", status: "down", error: "Out of memory" },
        ],
      });
      await store.saveRun({
        summary: summary(),
        results: [result(), rich, result({ key: "off", status: "unconfigured", probed: false, latencyMs: undefined })],
        samples: [sample(), sample({ key: "fly", status: "degraded" })],
      });
      await store.saveRun({
        summary: summary({ at: 2_000, full: false }),
        results: [result({ checkedAt: 2_000, status: "down", error: "HTTP 500", latencyMs: 300 })],
        samples: [sample({ at: 2_000, status: "down", error: "HTTP 500", latencyMs: 300 })],
      });

      const latest = await store.latest();
      expect(Object.keys(latest).sort()).toEqual(["api", "fly", "off"]);
      expect(clean(latest.api)).toEqual(clean(result({ checkedAt: 2_000, status: "down", error: "HTTP 500", latencyMs: 300 })));
      expect(clean(latest.fly)).toEqual(clean(rich));
      expect(latest.off?.status).toBe("unconfigured");
    });

    it("returns runs within an inclusive range, oldest first", async () => {
      const store = await createStore();
      for (const at of [3_000, 1_000, 2_000]) {
        await store.saveRun({
          summary: summary({ at, score: at / 100, failing: at === 2_000 ? { api: "down" } : {} }),
          results: [],
          samples: [],
        });
      }
      const runs = await store.runs({ since: 1_000, until: 2_000 });
      expect(runs.map((run) => run.at)).toEqual([1_000, 2_000]);
      expect(clean(runs[1])).toEqual(
        clean(summary({ at: 2_000, score: 20, failing: { api: "down" } }))
      );
      expect((await store.runs({ since: 0, until: 9_000 })).map((run) => run.at)).toEqual([1_000, 2_000, 3_000]);
    });

    it("returns samples of one service within an inclusive range, oldest first", async () => {
      const store = await createStore();
      await store.saveRun({
        summary: summary({ at: 2_000 }),
        results: [],
        samples: [
          sample({ at: 2_000, instances: { ams: ["up", 80], sin: ["sleeping"] } }),
          sample({ key: "other", at: 2_000 }),
        ],
      });
      await store.saveRun({ summary: summary({ at: 1_000 }), results: [], samples: [sample({ at: 1_000 })] });
      await store.saveRun({ summary: summary({ at: 3_000 }), results: [], samples: [sample({ at: 3_000 })] });

      const samples = await store.samples("api", { since: 1_000, until: 2_000 });
      expect(samples.map((s) => s.at)).toEqual([1_000, 2_000]);
      expect(samples.every((s) => s.key === "api")).toBe(true);
      expect(clean(samples[1]?.instances)).toEqual({ ams: ["up", 80], sin: ["sleeping"] });
    });

    it("prunes old runs and samples", async () => {
      const store = await createStore();
      for (const at of [1_000, 2_000, 3_000]) {
        await store.saveRun({ summary: summary({ at }), results: [result({ checkedAt: at })], samples: [sample({ at })] });
      }
      await store.prune({ before: 2_000 });
      expect((await store.runs({ since: 0, until: 9_000 })).map((run) => run.at)).toEqual([2_000, 3_000]);
      expect((await store.samples("api", { since: 0, until: 9_000 })).map((s) => s.at)).toEqual([2_000, 3_000]);
      // Latest results are not history: pruning by time keeps them
      expect(Object.keys(await store.latest())).toEqual(["api"]);
    });

    it("drops services that are not in keepKeys", async () => {
      const store = await createStore();
      await store.saveRun({
        summary: summary(),
        results: [result(), result({ key: "removed" })],
        samples: [sample(), sample({ key: "removed" })],
      });
      await store.prune({ before: 0, keepKeys: ["api"] });
      expect(Object.keys(await store.latest())).toEqual(["api"]);
      expect(await store.samples("removed", { since: 0, until: 9_000 })).toEqual([]);
      expect(await store.samples("api", { since: 0, until: 9_000 })).toHaveLength(1);
      expect(await store.runs({ since: 0, until: 9_000 })).toHaveLength(1);
    });

    it("locks by name until the time-to-live passes (when supported)", async () => {
      const store = await createStore();
      if (!store.lock) return;
      expect(await store.lock("run-all", 60_000)).toEqual({ ok: true });
      const second = await store.lock("run-all", 60_000);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.retryAfterMs).toBeGreaterThan(0);
        expect(second.retryAfterMs).toBeLessThanOrEqual(60_000);
      }
      expect(await store.lock("another", 60_000)).toEqual({ ok: true });

      expect(await store.lock("short", 20)).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await store.lock("short", 20)).toEqual({ ok: true });

      if (store.unlock) {
        await store.unlock("run-all");
        expect(await store.lock("run-all", 60_000)).toEqual({ ok: true });
        // Releasing a lock nobody holds is fine
        await store.unlock("never-taken");
      }
    });

    it("caches small values with a time-to-live (when supported)", async () => {
      const store = await createStore();
      if (!store.cache) return;
      expect(await store.cache.get("missing")).toBeNull();
      await store.cache.set("stats", '{"a":1}', 60_000);
      expect(await store.cache.get("stats")).toBe('{"a":1}');
      await store.cache.set("stats", '{"a":2}', 60_000);
      expect(await store.cache.get("stats")).toBe('{"a":2}');

      await store.cache.set("brief", "x", 20);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await store.cache.get("brief")).toBeNull();
    });
  });
}

export type MockRoute = {
  /** Matches when the request URL contains this string, or matches this pattern */
  url: string | RegExp;
  method?: string;
  status?: number;
  /** JSON-serialized when it's an object */
  body?: unknown;
  headers?: Record<string, string>;
  /** Reject the request like a network failure */
  error?: Error;
  /** Delay the response, to simulate latency */
  delayMs?: number;
};

export type MockFetch = typeof fetch & {
  /** Every request made, in order */
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
};

/**
 * A `fetch` that answers from a list of routes (first match wins) and records every call.
 * Unmatched requests fail, so tests prove that nothing unexpected is called.
 */
export function mockFetch(routes: MockRoute[]): MockFetch {
  const calls: MockFetch["calls"] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, method, headers, body: typeof init?.body === "string" ? init.body : undefined });

    const route = routes.find(
      (candidate) =>
        (typeof candidate.url === "string" ? url.includes(candidate.url) : candidate.url.test(url)) &&
        (!candidate.method || candidate.method.toUpperCase() === method)
    );
    if (!route) throw new TypeError(`mockFetch: no route for ${method} ${url}`);
    if (route.delayMs) await new Promise((resolve) => setTimeout(resolve, route.delayMs));
    if (route.error) throw route.error;
    const body =
      route.body === undefined ? "" : typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    // Null-body statuses (204, 304…) reject a body, even an empty one
    return new Response(body || null, { status: route.status ?? 200, headers: route.headers });
  };
  return Object.assign(impl as typeof fetch, { calls });
}

/**
 * Run one service exactly as the engine would (shared rules, redaction, timing) and return
 * its result. For testing presets and custom checks:
 *
 * ```ts
 * const fetch = mockFetch([{ url: "/health", status: 200 }]);
 * const result = await runCheck(myPreset({ … }), { fetch });
 * ```
 */
export async function runCheck(
  service: ServiceDefinition,
  options: { fetch?: typeof fetch; now?: () => number; cache?: Map<string, string> } = {}
): Promise<CheckResult> {
  const [resolved] = [...resolveTree([service]).services.values()];
  const cache = options.cache ?? new Map<string, string>();
  return runService({
    service: resolved!,
    secretValues: collectSecretValues([...Object.values(service.secrets), ...(service.sensitive ?? [])]),
    fetch: options.fetch,
    now: options.now,
    cache: {
      get: async (key) => cache.get(key) ?? null,
      set: async (key, value) => void cache.set(key, value),
    },
  });
}
