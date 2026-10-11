import type { CheckResult, ScoreLabel, Status, Trigger } from "./types";

/** One entry per run: drives the score history */
export type RunSummary = {
  at: number;
  trigger: Trigger;
  /** True when every service was checked (single-service runs are partial) */
  full: boolean;
  score: number | null;
  label: ScoreLabel;
  /** Only services that were degraded or down: key → status */
  failing: Record<string, Status>;
};

/** One entry per service per run: drives uptime, latency percentiles and sparklines */
export type CheckSample = {
  key: string;
  at: number;
  status: Status;
  latencyMs?: number;
  httpStatus?: number;
  error?: string;
  /** Per instance (e.g. region): key → [status, latency] */
  instances?: Record<string, [Status, number?]>;
};

export type TimeRange = { since: number; until: number };

export type LockResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Persistence for sermon-js. Implement these few methods to store history anywhere
 * (Redis, Postgres, MySQL, SQLite, MongoDB…). Statistics and bucketing are computed by the
 * library from what the store returns, so adapters only save and read rows.
 *
 * Verify an implementation with `runStoreConformance` from "sermon-js/testing".
 */
export interface StatusStore {
  /** Persist one run: upsert the latest result of each service, append its sample and the summary */
  saveRun(run: { summary: RunSummary; results: CheckResult[]; samples: CheckSample[] }): Promise<void>;
  /** The latest result of every service, by key */
  latest(): Promise<Record<string, CheckResult>>;
  /** Run summaries within the range (inclusive), oldest first */
  runs(range: TimeRange): Promise<RunSummary[]>;
  /** Samples of one service within the range (inclusive), oldest first */
  samples(key: string, range: TimeRange): Promise<CheckSample[]>;
  /**
   * Drop runs and samples older than `before`. When `keepKeys` is given, also drop everything
   * (latest results and samples) belonging to services not in that list.
   */
  prune(options: { before: number; keepKeys?: string[] }): Promise<void>;
  /**
   * Optional cross-instance lock (rate limits, single scheduled run). Without it the library
   * falls back to an in-process lock, which is enough for a single server.
   */
  lock?(name: string, ttlMs: number): Promise<LockResult>;
  /** Release a lock taken with `lock` before its time-to-live (optional; without it locks just expire) */
  unlock?(name: string): Promise<void>;
  /** Optional small cache (computed statistics, check state such as daily peaks) */
  cache?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlMs: number): Promise<void>;
  };
}
