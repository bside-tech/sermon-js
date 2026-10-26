import { labelForScore, type Scoring } from "./score";
import type { CheckSample, RunSummary } from "./store";
import type { HistoryBar, HistoryRange, InstanceStats, ScoreLabel, ServiceStats, Status } from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How far each range looks back, and its smallest bucket */
export const RANGES: Record<HistoryRange, { durationMs: number; bucketMs: number }> = {
  "24h": { durationMs: DAY_MS, bucketMs: 5 * 60 * 1000 },
  "7d": { durationMs: 7 * DAY_MS, bucketMs: 60 * 60 * 1000 },
};

/**
 * The width of one history bar: the check interval, so every bar holds one scheduled run
 * (a 15-minute interval gives 15-minute bars), and never less than the range's smallest
 * bucket, nor more than the range itself.
 */
export function bucketFor(range: HistoryRange, intervalMs?: number): number {
  const { durationMs, bucketMs } = RANGES[range];
  if (!intervalMs || !Number.isFinite(intervalMs)) return bucketMs;
  return Math.min(durationMs, Math.max(bucketMs, Math.round(intervalMs)));
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/** A share in percent with two decimals */
function percent(part: number, total: number): number | null {
  return total ? Math.round((part / total) * 10000) / 100 : null;
}

/** Share of samples that were not "down", in percent with two decimals */
function uptime(samples: Array<{ status: Status }>): number | null {
  return percent(samples.filter((sample) => sample.status !== "down").length, samples.length);
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

/**
 * What a service's statistics need from its history, kept between runs so that a run folds in
 * its new samples instead of reading the whole retention window again: the last 24h as they
 * are, and the rest of the week counted per hour.
 */
export type StatsWindow = {
  version: 1;
  /** Samples of the last 24h, oldest first, without their error */
  day: CheckSample[];
  /** Older samples of the week, per hour: [hour start, samples, samples that were not "down"] */
  hours: Array<[number, number, number]>;
  /** The most recent failure within the retention */
  lastFailure?: ServiceStats["lastFailure"];
};

const isFailure = (sample: CheckSample) => sample.status === "down" || sample.status === "degraded";

/**
 * Fold samples into a service's window and age out what fell out of it. Starting from no
 * window with every sample of the retention builds it from scratch. The week's oldest edge is
 * counted to the hour.
 */
export function updateStatsWindow({
  window,
  samples,
  now = Date.now(),
  retentionMs = 7 * DAY_MS,
}: {
  window?: StatsWindow;
  /** New samples of this service, in any order */
  samples: CheckSample[];
  now?: number;
  /** How long history is kept: nothing older counts */
  retentionMs?: number;
}): StatsWindow {
  // A sample saved again (same time) replaces the one already counted
  const fresh = new Map(samples.map((sample) => [sample.at, sample]));
  const merged = [...(window?.day ?? []).filter((sample) => !fresh.has(sample.at)), ...fresh.values()].sort(
    (a, b) => a.at - b.at
  );

  let lastFailure = window?.lastFailure;
  for (const sample of fresh.values()) {
    if (isFailure(sample) && (!lastFailure || sample.at >= lastFailure.at)) {
      lastFailure = { at: sample.at, status: sample.status, error: sample.error };
    }
  }
  if (lastFailure && lastFailure.at < now - retentionMs) lastFailure = undefined;

  const weekStart = now - Math.min(7 * DAY_MS, retentionMs);
  const dayStart = Math.max(now - DAY_MS, weekStart);
  const hours = new Map((window?.hours ?? []).map(([start, total, available]) => [start, [total, available]]));
  const day: CheckSample[] = [];
  for (const { error: _error, ...sample } of merged) {
    if (sample.at >= dayStart) {
      day.push(sample);
      continue;
    }
    const start = Math.floor(sample.at / HOUR_MS) * HOUR_MS;
    const [total = 0, available = 0] = hours.get(start) ?? [];
    hours.set(start, [total + 1, available + (sample.status === "down" ? 0 : 1)]);
  }

  return {
    version: 1,
    day,
    // An hour stays while any of it is within the week
    hours: [...hours]
      .filter(([start]) => start + HOUR_MS > weekStart)
      .sort(([a], [b]) => a - b)
      .map(([start, [total = 0, available = 0]]) => [start, total, available]),
    lastFailure,
  };
}

/** A service's statistics from its window (see `updateStatsWindow`) */
export function statsFromWindow({ window, now = Date.now() }: { window: StatsWindow; now?: number }): ServiceStats {
  const stats = computeServiceStats({ samples: window.day, now });
  let total = window.day.length;
  let available = window.day.filter((sample) => sample.status !== "down").length;
  for (const [, count, up] of window.hours) {
    total += count;
    available += up;
  }
  return { ...stats, uptime7d: percent(available, total), lastFailure: window.lastFailure };
}

const LABEL_SEVERITY: Record<ScoreLabel, number> = { unknown: 0, operational: 1, degraded: 2, outage: 3 };

/** Group runs into fixed buckets; each bucket keeps its worst score, label and failures */
export function bucketRuns({
  runs,
  range,
  now = Date.now(),
  scoring,
  bucketMs = RANGES[range].bucketMs,
}: {
  runs: RunSummary[];
  range: HistoryRange;
  now?: number;
  scoring?: Scoring;
  /** Width of one bar (default: the range's smallest bucket). See `bucketFor`. */
  bucketMs?: number;
}): HistoryBar[] {
  const { durationMs } = RANGES[range];
  const end = Math.floor(now / bucketMs) * bucketMs + bucketMs;
  // An interval that doesn't divide the range still covers all of it
  const count = Math.ceil(durationMs / bucketMs);
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
