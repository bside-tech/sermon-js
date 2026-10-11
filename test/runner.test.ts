import { describe, expect, it, vi } from "vitest";
import { custom, resolveTree, type ServiceDefinition } from "../src/config";
import { runService } from "../src/runner";
import { collectSecretValues } from "../src/sanitize";
import { mockFetch } from "../src/testing";
import type { CheckCache } from "../src/types";

const noCache: CheckCache = { get: async () => null, set: async () => undefined };

const run = (service: ServiceDefinition, fetch = mockFetch([])) => {
  const [resolved] = [...resolveTree([service]).services.values()];
  return runService({
    service: resolved!,
    secretValues: collectSecretValues(Object.values(service.secrets)),
    cache: noCache,
    fetch,
    now: () => 5_000,
  });
};

describe("custom() contract", () => {
  it("maps true / nothing to up and false to down", async () => {
    expect(await run(custom({ name: "a", check: () => true }))).toMatchObject({ status: "up", probed: true });
    expect((await run(custom({ name: "a", check: async () => undefined }))).status).toBe("up");
    expect((await run(custom({ name: "a", check: () => false }))).status).toBe("down");
  });

  it("measures latency when the check doesn't", async () => {
    const result = await run(
      custom({ name: "a", check: () => new Promise((resolve) => setTimeout(() => resolve(true), 30)) })
    );
    expect(result.latencyMs).toBeGreaterThanOrEqual(25);
    expect(result).toMatchObject({ key: "a", checkedAt: 5_000 });
  });

  it("passes a full outcome through", async () => {
    const result = await run(
      custom({
        name: "Queue",
        check: () => ({
          status: "degraded",
          latencyMs: 12,
          httpStatus: 200,
          error: "Queue almost full",
          metrics: { workers: 4 },
          usage: [{ label: "Queue", used: 95, limit: 100, unit: "jobs" }],
          instances: [{ key: "ams", status: "up", latencyMs: 10 }],
        }),
      })
    );
    expect(result).toEqual({
      key: "queue",
      status: "degraded",
      checkedAt: 5_000,
      probed: true,
      latencyMs: 12,
      httpStatus: 200,
      error: "Queue almost full",
      metrics: { workers: 4 },
      usage: [{ label: "Queue", used: 95, limit: 100, unit: "jobs" }],
      instances: [{ key: "ams", status: "up", latencyMs: 10, error: undefined }],
    });
  });

  it("turns a throw into down, with secrets redacted", async () => {
    const result = await run(
      custom({
        name: "a",
        secrets: { apiKey: "super-secret-key" },
        check: ({ secrets }) => {
          throw new Error(`auth failed for ${secrets.apiKey}`);
        },
      })
    );
    expect(result).toMatchObject({ status: "down", error: "auth failed for ***" });
    expect(result.latencyMs).toBeUndefined();
  });

  it("never calls the check of a service that is not configured", async () => {
    const check = vi.fn(() => true);
    const result = await run(custom({ name: "a", secrets: { apiKey: undefined }, check }));
    expect(result).toEqual({ key: "a", status: "unconfigured", checkedAt: 5_000, probed: false });
    expect(check).not.toHaveBeenCalled();
  });

  it("degrades slow responses, keeping an existing error", async () => {
    const slow = await run(custom({ name: "a", slowMs: 100, check: () => ({ status: "up", latencyMs: 250 }) }));
    expect(slow).toMatchObject({ status: "degraded", error: "Slow response: 250 ms (threshold 100 ms)" });
    const fast = await run(custom({ name: "a", slowMs: 100, check: () => ({ status: "up", latencyMs: 99 }) }));
    expect(fast.status).toBe("up");
  });

  it("does not time or degrade services that were deliberately not probed", async () => {
    const result = await run(custom({ name: "a", check: () => ({ status: "sleeping", probed: false }) }));
    expect(result).toMatchObject({ status: "sleeping", probed: false });
    expect(result.latencyMs).toBeUndefined();
  });

  it("gives up on a check that ignores its time budget", async () => {
    vi.useFakeTimers();
    try {
      const pending = run(custom({ name: "a", timeoutMs: 100, check: () => new Promise(() => undefined) }));
      await vi.advanceTimersByTimeAsync(1_200);
      expect(await pending).toMatchObject({ status: "down", error: "Timed out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("provides http, measure and combine helpers", async () => {
    const fetch = mockFetch([
      { url: "/stats", body: { waiting: 3, limit: 10 } },
      { url: "/broken", status: 503, body: "maintenance" },
    ]);
    const ok = await run(
      custom({
        name: "Queue",
        secrets: { apiKey: "queue-key-123" },
        check: async ({ secrets, http }) => {
          const res = await http("https://queue.test/stats", { headers: { Authorization: `Bearer ${secrets.apiKey}` } });
          if (!res.ok) return res.outcome;
          const { waiting, limit } = res.json as { waiting: number; limit: number };
          return { status: "up", usage: [{ label: "Queue", used: waiting, limit }] };
        },
      }),
      fetch
    );
    expect(ok).toMatchObject({ status: "up", usage: [{ label: "Queue", used: 3, limit: 10 }] });
    expect(fetch.calls[0]?.headers.authorization).toBe("Bearer queue-key-123");

    const failed = await run(
      custom({ name: "Queue", check: async ({ http }) => (await http("https://queue.test/broken")).outcome }),
      fetch
    );
    expect(failed).toMatchObject({ status: "down", httpStatus: 503, error: "HTTP 503: maintenance" });

    const merged = await run(
      custom({
        name: "Both",
        check: async ({ http, measure, combine }) =>
          combine([(await http("https://queue.test/stats")).outcome, await measure(async () => false)]),
      }),
      fetch
    );
    expect(merged.status).toBe("down");
  });
});
