import { describe, expect, it } from "vitest";
import { bucketFor, bucketRuns, computeServiceStats, statsFromWindow, updateStatsWindow } from "../src/history";
import type { CheckSample, RunSummary } from "../src/store";

const now = Date.UTC(2026, 9, 9, 12, 2);

describe("bucketFor", () => {
  const MIN = 60_000;

  it("makes bars as wide as the check interval", () => {
    expect(bucketFor("24h", 5 * MIN)).toBe(5 * MIN);
    expect(bucketFor("24h", 10 * MIN)).toBe(10 * MIN);
    expect(bucketFor("24h", 15 * MIN)).toBe(15 * MIN);
    expect(bucketFor("7d", 2 * 60 * MIN)).toBe(2 * 60 * MIN);
  });

  it("never goes below the range's smallest bucket, nor above the range", () => {
    expect(bucketFor("24h", MIN)).toBe(5 * MIN);
    expect(bucketFor("7d", 15 * MIN)).toBe(60 * MIN);
    expect(bucketFor("24h", 48 * 60 * MIN)).toBe(24 * 60 * MIN);
    expect(bucketFor("24h")).toBe(5 * MIN);
  });

  it("gives one bar per scheduled run", () => {
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);
    const bucketMs = bucketFor("24h", 15 * MIN);
    const runs = Array.from({ length: 96 }, (_, i) => ({
      at: now - i * 15 * MIN,
      trigger: "scheduled" as const,
      full: true,
      score: 100,
      label: "operational" as const,
      failing: {},
    }));
    const bars = bucketRuns({ runs, range: "24h", now, bucketMs });
    expect(bars).toHaveLength(96);
    expect(bars.every((bar) => bar.runs === 1)).toBe(true);
  });

  it("covers the whole range when the interval doesn't divide it", () => {
    expect(bucketRuns({ runs: [], range: "24h", now: 0, bucketMs: 7 * MIN })).toHaveLength(206);
  });
});

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

describe("updateStatsWindow", () => {
  const HOUR = 3600_000;
  const sample = (overrides: Partial<CheckSample>): CheckSample => ({ key: "api", at: now, status: "up", ...overrides });
  // Every 20 minutes over three days, down once an hour
  const history = Array.from({ length: 3 * 72 }, (_, i) =>
    sample({ at: now - i * 20 * 60_000, status: i % 3 ? "up" : "down", latencyMs: 100 + i, error: i % 3 ? undefined : `fail ${i}` })
  ).reverse();

  it("gives the same statistics as the whole history, folded in one run at a time", () => {
    let window = updateStatsWindow({ samples: [], now: history[0]!.at });
    for (const item of history) window = updateStatsWindow({ window, samples: [item], now: item.at });
    expect(statsFromWindow({ window, now })).toEqual(computeServiceStats({ samples: history, now }));
    // Built at once from the stored history, too
    expect(statsFromWindow({ window: updateStatsWindow({ samples: history, now }), now })).toEqual(
      computeServiceStats({ samples: history, now })
    );
  });

  it("keeps only the last 24h as samples and counts the rest of the week per hour", () => {
    const window = updateStatsWindow({ samples: history, now });
    expect(window.day.every((item) => item.at >= now - 24 * HOUR && item.error === undefined)).toBe(true);
    expect(window.hours.reduce((sum, [, total]) => sum + total, 0) + window.day.length).toBe(history.length);
  });

  it("ages out the week to the hour, and failures past the retention", () => {
    const old = sample({ at: now - 7 * 24 * HOUR - 2 * HOUR, status: "down" });
    const window = updateStatsWindow({ samples: [old, sample({ at: now })], now });
    expect(statsFromWindow({ window, now })).toMatchObject({ uptime7d: 100, lastFailure: undefined });
  });

  it("counts a sample saved again only once", () => {
    const first = updateStatsWindow({ samples: [sample({ status: "down" })], now });
    const again = updateStatsWindow({ window: first, samples: [sample({ status: "up" })], now });
    expect(statsFromWindow({ window: again, now })).toMatchObject({ uptime24h: 100, samples24h: 1 });
  });
});
