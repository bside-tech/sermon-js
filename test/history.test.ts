import { describe, expect, it } from "vitest";
import { bucketRuns, computeServiceStats } from "../src/history";
import type { CheckSample, RunSummary } from "../src/store";

const now = Date.UTC(2026, 9, 9, 12, 2);

describe("bucketRuns", () => {
  const run = (minutesAgo: number, score: number, failing: RunSummary["failing"] = {}): RunSummary => ({
    at: now - minutesAgo * 60_000,
    trigger: "scheduled",
    full: true,
    score,
    label: score >= 98 ? "operational" : score >= 85 ? "degraded" : "outage",
    failing,
  });

  it("produces fixed-size ranges", () => {
    expect(bucketRuns({ runs: [], range: "24h", now })).toHaveLength(288);
    expect(bucketRuns({ runs: [], range: "7d", now })).toHaveLength(168);
  });

  it("keeps the worst score, label and failures of a bucket", () => {
    const bars = bucketRuns({
      runs: [run(1, 100), run(2, 70, { gladia: "degraded" }), run(1.5, 90, { gladia: "down" })],
      range: "24h",
      now,
    });
    expect(bars.at(-1)).toMatchObject({ score: 70, label: "outage", runs: 3, failing: { gladia: "down" } });
    expect(bars[0]).toMatchObject({ score: null, label: "unknown", runs: 0 });
  });

  it("ignores runs outside the range", () => {
    const bars = bucketRuns({ runs: [run(60 * 25, 10)], range: "24h", now });
    expect(bars.every((bar) => bar.runs === 0)).toBe(true);
  });
});

describe("computeServiceStats", () => {
  const sample = (overrides: Partial<CheckSample>): CheckSample => ({ key: "api", at: now, status: "up", ...overrides });

  it("computes uptime and latency percentiles", () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample({ at: now - (9 - i) * 60_000, status: i === 9 ? "down" : "up", latencyMs: (10 - i) * 100, error: i === 9 ? "HTTP 500" : undefined })
    );
    const stats = computeServiceStats({ samples, now });
    expect(stats.uptime24h).toBe(90);
    expect(stats.p50).toBe(600);
    expect(stats.p95).toBe(1000);
    expect(stats.samples24h).toBe(10);
    expect(stats.latency).toHaveLength(10);
    expect(stats.lastFailure).toEqual({ at: now, status: "down", error: "HTTP 500" });
  });

  it("uses only the last 24h for daily figures", () => {
    const stats = computeServiceStats({
      now,
      samples: [sample({ at: now - 2 * 24 * 3600_000, status: "down" }), sample({ at: now - 1000, latencyMs: 50 })],
    });
    expect(stats.uptime24h).toBe(100);
    expect(stats.uptime7d).toBe(50);
  });

  it("counts sleeping as available and leaves it out of latency", () => {
    const stats = computeServiceStats({
      now,
      samples: [sample({ at: now - 2000, status: "sleeping" }), sample({ at: now - 1000, latencyMs: 80 })],
    });
    expect(stats.uptime24h).toBe(100);
    expect(stats.p50).toBe(80);
    expect(stats.latency).toEqual([null, 80]);
  });

  it("computes per-instance figures", () => {
    const stats = computeServiceStats({
      now,
      samples: [
        sample({ at: now - 3000, status: "degraded", instances: { ams: ["up", 100], sin: ["down"] } }),
        sample({ at: now - 2000, instances: { ams: ["up", 300], sin: ["sleeping"] } }),
      ],
    });
    expect(stats.instances).toEqual({
      ams: { uptime24h: 100, p50: 100, samples24h: 2 },
      sin: { uptime24h: 50, p50: null, samples24h: 2 },
    });
  });

  it("handles no data", () => {
    expect(computeServiceStats({ samples: [], now })).toMatchObject({ uptime24h: null, p50: null, latency: [] });
  });
});
