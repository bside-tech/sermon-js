import { labelForScore, type Scoring } from "./score";
import type { CheckSample, RunSummary } from "./store";
import type { HistoryBar, HistoryRange, InstanceStats, ScoreLabel, ServiceStats, Status } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGES: Record<HistoryRange, { durationMs: number; bucketMs: number }> = {
  "24h": { durationMs: DAY_MS, bucketMs: 5 * 60 * 1000 },
  "7d": { durationMs: 7 * DAY_MS, bucketMs: 60 * 60 * 1000 },
};

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/** Share of samples that were not "down", in percent with two decimals */
function uptime(samples: Array<{ status: Status }>): number | null {
  if (!samples.length) return null;
  const available = samples.filter((sample) => sample.status !== "down").length;
  return Math.round((available / samples.length) * 10000) / 100;
}

const measured = (sample: { status: Status; latencyMs?: number }) =>
  sample.latencyMs !== undefined && (sample.status === "up" || sample.status === "degraded");

/** Uptime, latency percentiles, sparkline series and last failure of one service */
export function computeServiceStats({
  samples,
  now = Date.now(),
}: {
  /** Samples of the whole retention window, oldest first */
  samples: CheckSample[];
  now?: number;
}): ServiceStats {
  const day = samples.filter((sample) => sample.at >= now - DAY_MS);
  const week = samples.filter((sample) => sample.at >= now - 7 * DAY_MS);
  const latencies = day
    .filter(measured)
    .map((sample) => sample.latencyMs as number)
    .sort((a, b) => a - b);
  const lastFailure = [...samples]
    .reverse()
    .find((sample) => sample.status === "down" || sample.status === "degraded");

  // Same figures per instance, over the last 24h
  const byInstance = new Map<string, Array<{ status: Status; latencyMs?: number }>>();
  for (const sample of day) {
    for (const [key, [status, latencyMs]] of Object.entries(sample.instances ?? {})) {
      byInstance.set(key, [...(byInstance.get(key) ?? []), { status, latencyMs }]);
    }
  }
  const instances: Record<string, InstanceStats> | undefined = byInstance.size
    ? Object.fromEntries(
        [...byInstance].map(([key, list]) => [
          key,
          {
            uptime24h: uptime(list),
            p50: percentile(
              list
                .filter(measured)
                .map((item) => item.latencyMs as number)
                .sort((a, b) => a - b),
              50
            ),
            samples24h: list.length,
          },
        ])
      )
    : undefined;

  return {
    uptime24h: uptime(day),
    uptime7d: uptime(week),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    samples24h: day.length,
    latency: day.map((sample) => sample.latencyMs ?? null),
    lastFailure: lastFailure
      ? { at: lastFailure.at, status: lastFailure.status, error: lastFailure.error }
      : undefined,
    instances,
  };
}

const LABEL_SEVERITY: Record<ScoreLabel, number> = { unknown: 0, operational: 1, degraded: 2, outage: 3 };

/** Group runs into fixed buckets; each bucket keeps its worst score, label and failures */
export function bucketRuns({
  runs,
  range,
  now = Date.now(),
  scoring,
}: {
  runs: RunSummary[];
  range: HistoryRange;
  now?: number;
  scoring?: Scoring;
}): HistoryBar[] {
  const { durationMs, bucketMs } = RANGES[range];
  const end = Math.floor(now / bucketMs) * bucketMs + bucketMs;
  const count = Math.round(durationMs / bucketMs);
  const start = end - count * bucketMs;

  const bars: HistoryBar[] = Array.from({ length: count }, (_, i) => ({
    start: start + i * bucketMs,
    score: null,
    label: "unknown",
    runs: 0,
    failing: {},
  }));

  for (const run of runs) {
    const bar = bars[Math.floor((run.at - start) / bucketMs)];
    if (!bar) continue;
    bar.runs += 1;
    if (run.score !== null && (bar.score === null || run.score < bar.score)) bar.score = run.score;
    const label = run.label ?? labelForScore(run.score, scoring);
    if (LABEL_SEVERITY[label] > LABEL_SEVERITY[bar.label]) bar.label = label;
    for (const [key, status] of Object.entries(run.failing)) {
      // "down" wins over "degraded" within a bucket
      if (bar.failing[key] !== "down") bar.failing[key] = status;
    }
  }
  return bars;
}
