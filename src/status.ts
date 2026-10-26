import { resolveTree, type ResolvedNode, type ResolvedService, type ServiceNode } from "./config";
import { toMs, type Duration } from "./duration";
import { bucketFor, bucketRuns, RANGES, statsFromWindow, updateStatsWindow, type StatsWindow } from "./history";
import { runServices } from "./runner";
import { collectSecretValues, redactText } from "./sanitize";
import { computeScore, resolveScoring, type Scoring, type ScoringInput } from "./score";
import type { CheckSample, LockResult, RunSummary, StatusStore } from "./store";
import { memoryStore } from "./stores/memory";
import type {
  CheckCache,
  CheckResult,
  HistoryPayload,
  HistoryRange,
  Instance,
  ScoreLabel,
  ServiceStats,
  SnapshotNode,
  StatusSnapshot,
  Trigger,
} from "./types";

export type StatusConfig = {
  /** What to supervise: services built with presets or `custom()`, optionally nested in `group()`s */
  services: ServiceNode[];
  /** Where history is kept. Defaults to memory, which lasts as long as the process. */
  store?: StatusStore;
  /** How often a full run is due (default "5m"). Used by `tick()`, the scheduler and staleness. */
  interval?: Duration;
  /** How long history is kept (default "7d") */
  retention?: Duration;
  scoring?: ScoringInput;
  /**
   * Never quote what a service replied in public errors: a failed HTTP answer is reported by
   * its status code only ("HTTP 500"). Turn it on when a checked service could answer with
   * something sensitive, such as a debug page. Default false. Errors returned by `custom()`
   * checks are yours and are kept (redacted) either way.
   */
  hideResponseBodies?: boolean;
  /** Receives configuration warnings (default: `console.warn`) */
  onWarning?: (message: string) => void;
  /** Override `fetch` (tests, custom agents) */
  fetch?: typeof fetch;
  /** Override the clock (tests) */
  now?: () => number;
};

export type RunReport = {
  at: number;
  trigger: Trigger;
  /** True when every service was checked */
  full: boolean;
  score: number | null;
  label: ScoreLabel;
  results: CheckResult[];
};

export type ServiceHistory = { schemaVersion: 1; key: string; range: HistoryRange; samples: CheckSample[] };

export type TickResult =
  | { ran: true; report: RunReport }
  | {
      ran: false;
      /** "not-due": the last full run is recent enough. "locked": another tick is running. */
      reason: "not-due" | "locked";
      /** When the next full run is due (ms epoch) */
      nextDueAt: number;
    };

export type Status = {
  /** Check every service (or only `keys`) now, and record the results */
  run(options?: { keys?: string[]; trigger?: Trigger }): Promise<RunReport>;
  /**
   * Run every service only if a full run is due (the last one is older than `interval`), and
   * never twice at once. Safe to call as often as you like, from any number of triggers:
   * a cron, a platform scheduler, a timer, a page view.
   */
  tick(options?: { force?: boolean }): Promise<TickResult>;
  /** Everything a status page needs: the tree with latest results, statistics and the score */
  snapshot(): Promise<StatusSnapshot>;
  /**
   * The page as it was during a past period (typically one history bar): each service shows
   * its worst result of the period, with the error and per-instance statuses recorded then.
   * Metrics, usage and statistics are not kept per run, so they are absent.
   */
  snapshotAt(period: { start: number; end: number }): Promise<StatusSnapshot>;
  /** Score history in fixed buckets */
  history(options?: { range?: HistoryRange }): Promise<HistoryPayload>;
  /** Raw samples of one service */
  serviceHistory(key: string, options?: { range?: HistoryRange }): Promise<ServiceHistory>;
  /**
   * Remove every configured secret (and anything shaped like a credential) from a text.
   * Use it before logging errors that come from checks, stores or drivers.
   */
  redact(text: string): string;
  /** Whether a service with this key exists */
  has(key: string): boolean;
  /** Take a named lock for `ttlMs` (the store's when it has one, otherwise in-process) */
  lock(name: string, ttlMs: number): Promise<LockResult>;
  /** When the last full run happened, if any within the retention window */
  lastFullRun(): Promise<{ at: number; trigger: Trigger } | null>;
  readonly services: ReadonlyMap<string, ResolvedService>;
  readonly tree: readonly ResolvedNode[];
  readonly store: StatusStore;
  readonly intervalMs: number;
  readonly retentionMs: number;
  readonly scoring: Scoring;
  readonly warnings: readonly string[];
};

const SAMPLE_SEVERITY: Record<CheckSample["status"], number> = { unconfigured: 0, sleeping: 1, up: 2, degraded: 3, down: 4 };
const LABEL_SEVERITY: Record<ScoreLabel, number> = { unknown: 0, operational: 1, degraded: 2, outage: 3 };

const TICK_LOCK = "sermon:tick";
const STATS_KEY = "sermon:stats";
const LAST_RUN_KEY = "sermon:last-full-run";
const windowKey = (key: string) => `sermon:stats-window:${key}`;

function sampleOf(result: CheckResult): CheckSample {
  const healthy = result.status === "up" || result.status === "sleeping";
  return {
    key: result.key,
    at: result.checkedAt,
    status: result.status,
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    error: healthy ? undefined : result.error,
    instances: result.instances?.length
      ? Object.fromEntries(
          result.instances.map((instance) => [instance.key, [instance.status, instance.latencyMs]])
        )
      : undefined,
  };
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Describe what to supervise and get a status engine: run checks, read snapshots and history.
 * Nothing here depends on a host or a framework; see "sermon-js/api" to expose it over HTTP.
 */
export function defineStatus(config: StatusConfig): Status {
  const now = config.now ?? (() => Date.now());
  const resolved = resolveTree(config.services ?? []);
  const { services, tree } = resolved;
  const store = config.store ?? memoryStore({ now });
  const intervalMs = toMs(config.interval ?? "5m");
  const retentionMs = toMs(config.retention ?? "7d");
  const scoring = resolveScoring(config.scoring);
  const warn = config.onWarning ?? ((message: string) => console.warn(`[sermon-js] ${message}`));
  for (const warning of resolved.warnings) warn(warning);

  const secretValues = collectSecretValues(
    [...services.values()].flatMap((service) => [...Object.values(service.secrets), ...(service.sensitive ?? [])])
  );

  // Fallbacks for stores without a cache or a lock: fine for a single process
  const fallback = memoryStore({ now });
  const cache = store.cache ?? fallback.cache!;
  const lock = (name: string, ttlMs: number) =>
    store.lock ? store.lock(name, ttlMs) : fallback.lock!(name, ttlMs);
  const unlock = async (name: string) => {
    if (store.lock) await store.unlock?.(name);
    else await fallback.unlock!(name);
  };

  // A full run can't outlast its slowest check by much: that bounds how long the tick lock is held
  const longestCheckMs = Math.max(0, ...[...services.values()].map((service) => service.timeoutMs));
  const tickLockMs = longestCheckMs + 6_000;

  const checkCache = (key: string): CheckCache => ({
    get: (name) => cache.get(`sermon:check:${key}:${name}`),
    set: (name, value, ttlMs) => cache.set(`sermon:check:${key}:${name}`, value, ttlMs),
  });

  /** Latest results of the services that still exist; a service that lost its configuration drops its old result */
  async function currentLatest() {
    const stored = await store.latest();
    const latest: Record<string, CheckResult> = {};
    for (const [key, service] of services) {
      const result = stored[key];
      if (!result) continue;
      if (service.missing.length > 0 && result.status !== "unconfigured") continue;
      latest[key] = result;
    }
    return latest;
  }

  function scoreOf(latest: Record<string, CheckResult>) {
    return computeScore({
      scoring,
      results: [...services.values()]
        .filter((service) => latest[service.key])
        .map((service) => ({ status: latest[service.key]!.status, critical: service.critical })),
    });
  }

  async function readStats() {
    return parseJson<Record<string, ServiceStats>>(await cache.get(STATS_KEY)) ?? {};
  }

  /**
   * Update the statistics of some services with their new samples and cache them all together.
   * Each service keeps a window in the store's cache, so this reads no history; the store's
   * samples are read only to build a window the cache doesn't have.
   */
  async function refreshStats(
    keys: string[],
    { samples = [], known }: { samples?: CheckSample[]; known?: Record<string, ServiceStats> } = {}
  ) {
    const at = now();
    const stats = known ?? (await readStats());
    await Promise.all(
      keys.map(async (key) => {
        // Windows live only in the store's cache: one per process would miss the other processes' runs
        const cached = store.cache ? parseJson<StatsWindow>(await store.cache.get(windowKey(key))) : undefined;
        const known = cached?.version === 1 ? cached : undefined;
        const window = updateStatsWindow({
          window: known,
          samples: known
            ? samples.filter((sample) => sample.key === key)
            : await store.samples(key, { since: at - retentionMs, until: at }),
          now: at,
          retentionMs,
        });
        await store.cache?.set(windowKey(key), JSON.stringify(window), retentionMs);
        stats[key] = statsFromWindow({ window, now: at });
      })
    );
    // Forget services that no longer exist
    for (const key of Object.keys(stats)) if (!services.has(key)) delete stats[key];
    await cache.set(STATS_KEY, JSON.stringify(stats), retentionMs);
    return stats;
  }

  async function lastFullRun() {
    const cached = parseJson<{ at: number; trigger: Trigger }>(await cache.get(LAST_RUN_KEY));
    if (cached) return cached;
    const at = now();
    const runs = await store.runs({ since: at - retentionMs, until: at });
    const last = [...runs].reverse().find((run) => run.full);
    return last ? { at: last.at, trigger: last.trigger } : null;
  }

  const status: Status = {
    services,
    tree,
    store,
    intervalMs,
    retentionMs,
    scoring,
    warnings: resolved.warnings,
    redact: (text) => redactText({ text, secretValues }),
    has: (key) => services.has(key),
    lock,
    lastFullRun,

    async run({ keys, trigger = "manual" } = {}) {
      const unknown = (keys ?? []).filter((key) => !services.has(key));
      if (unknown.length) throw new Error(`sermon-js: unknown service key(s): ${unknown.join(", ")}`);
      const selected = keys ? keys.map((key) => services.get(key)!) : [...services.values()];
      const full = !keys;

      const results = await runServices({
        services: selected,
        secretValues,
        cacheFor: checkCache,
        now,
        fetch: config.fetch,
        hideResponseBodies: config.hideResponseBodies,
      });

      // The overall score always reflects the whole system: merge with what we already know
      const latest = full ? {} : await currentLatest();
      for (const result of results) latest[result.key] = result;
      const { score, label } = scoreOf(latest);

      const at = now();
      const failing: RunSummary["failing"] = {};
      for (const result of results) {
        if (result.status === "down" || result.status === "degraded") failing[result.key] = result.status;
      }
      const summary: RunSummary = { at, trigger, full, score, label, failing };
      const samples = results.filter((result) => result.status !== "unconfigured").map(sampleOf);

      await store.saveRun({ summary, results, samples });
      if (full) {
        await store.prune({ before: at - retentionMs, keepKeys: [...services.keys()] });
        await cache.set(LAST_RUN_KEY, JSON.stringify({ at, trigger }), retentionMs);
      }
      await refreshStats(samples.map((sample) => sample.key), { samples });

      return { at, trigger, full, score, label, results };
    },

    async tick({ force = false } = {}) {
      const at = now();
      // Schedulers fire a little early or late: a run counts as due slightly before the interval ends
      const tolerance = Math.min(intervalMs * 0.1, 30_000);
      const last = await lastFullRun();
      if (!force && last && at - last.at < intervalMs - tolerance) {
        return { ran: false, reason: "not-due", nextDueAt: last.at + intervalMs };
      }
      // Only one run at a time. The lock expires by itself if a run dies, and is released as soon
      // as a run ends, so the "due" check above is what paces the runs.
      const held = await lock(TICK_LOCK, tickLockMs);
      if (!held.ok) {
        return { ran: false, reason: "locked", nextDueAt: at + held.retryAfterMs };
      }
      try {
        // Another instance may have finished a run between our check and taking the lock
        const latest = force ? null : await lastFullRun();
        if (latest && now() - latest.at < intervalMs - tolerance) {
          return { ran: false, reason: "not-due", nextDueAt: latest.at + intervalMs };
        }
        return { ran: true, report: await status.run({ trigger: "scheduled" }) };
      } finally {
        await unlock(TICK_LOCK).catch(() => undefined);
      }
    },

    async snapshot() {
      const at = now();
      const [latest, cachedStats, lastRun] = await Promise.all([currentLatest(), readStats(), lastFullRun()]);

      // Statistics are normally cached at run time; rebuild whatever is missing (cold cache)
      const missing = Object.values(latest)
        .filter((result) => result.status !== "unconfigured" && !cachedStats[result.key])
        .map((result) => result.key);
      const stats = missing.length ? await refreshStats(missing, { known: cachedStats }) : cachedStats;

      const toSnapshot = (node: ResolvedNode): SnapshotNode => {
        if (node.type === "group") {
          return {
            type: "group",
            key: node.key,
            title: node.title,
            description: node.description,
            children: node.children.map(toSnapshot),
          };
        }
        const service = services.get(node.key)!;
        const configured = service.missing.length === 0;
        return {
          type: "service",
          key: service.key,
          kind: service.kind,
          name: service.name,
          description: service.description,
          critical: service.critical,
          slowMs: service.slowMs,
          configured,
          missing: configured ? undefined : service.missing,
          result: latest[service.key],
          stats: configured ? stats[service.key] : undefined,
        };
      };

      const checkedAts = Object.values(latest).map((result) => result.checkedAt);
      return {
        schemaVersion: 1,
        generatedAt: at,
        lastCheckedAt: checkedAts.length ? Math.max(...checkedAts) : null,
        lastRunAt: lastRun?.at ?? null,
        lastRunTrigger: lastRun?.trigger ?? null,
        nextDueAt: lastRun ? lastRun.at + intervalMs : null,
        intervalMs,
        retentionMs,
        ...scoreOf(latest),
        tree: tree.map(toSnapshot),
      };
    },

    async snapshotAt({ start, end }) {
      const at = now();
      const range = { since: start, until: end };
      const keys = [...services.keys()];
      const [runs, latest, ...sampleLists] = await Promise.all([
        store.runs(range),
        currentLatest(),
        ...keys.map((key) => store.samples(key, range)),
      ]);

      // The worst sample of each service in the period; among equals, the most recent
      const results: Record<string, CheckResult> = {};
      keys.forEach((key, index) => {
        let worst: CheckSample | undefined;
        for (const sample of sampleLists[index] ?? []) {
          if (!worst || SAMPLE_SEVERITY[sample.status] >= SAMPLE_SEVERITY[worst.status]) worst = sample;
        }
        if (!worst) return;
        // Samples only keep each instance's status and latency: names come from the latest result
        const known = new Map((latest[key]?.instances ?? []).map((instance) => [instance.key, instance]));
        results[key] = {
          key,
          status: worst.status,
          checkedAt: worst.at,
          probed: worst.status !== "sleeping",
          latencyMs: worst.latencyMs,
          httpStatus: worst.httpStatus,
          error: worst.error,
          instances: worst.instances
            ? Object.entries(worst.instances).map(([instanceKey, [status, latencyMs]]) => ({
                key: instanceKey,
                region: known.get(instanceKey)?.region,
                id: known.get(instanceKey)?.id,
                status: status as Instance["status"],
                latencyMs,
              }))
            : undefined,
          instanceLabels: worst.instances ? latest[key]?.instanceLabels : undefined,
        };
      });

      const toSnapshot = (node: ResolvedNode): SnapshotNode => {
        if (node.type === "group") {
          return { type: "group", key: node.key, title: node.title, description: node.description, children: node.children.map(toSnapshot) };
        }
        const service = services.get(node.key)!;
        return {
          type: "service",
          key: service.key,
          kind: service.kind,
          name: service.name,
          description: service.description,
          critical: service.critical,
          slowMs: service.slowMs,
          // What was recorded then is what counts, not whether the service is configured now
          configured: !!results[service.key],
          result: results[service.key],
        };
      };

      // Same figure as the history bar of this period: the worst score among its runs
      const computed = scoreOf(results);
      const scores = runs.map((run) => run.score).filter((score): score is number => score !== null);
      const score = scores.length ? Math.min(...scores) : computed.score;
      const label = runs.length
        ? runs.map((run) => run.label).reduce((a, b) => (LABEL_SEVERITY[b] > LABEL_SEVERITY[a] ? b : a))
        : computed.label;
      const checkedAts = Object.values(results).map((result) => result.checkedAt);
      const lastRun = runs[runs.length - 1];
      return {
        schemaVersion: 1,
        generatedAt: at,
        lastCheckedAt: checkedAts.length ? Math.max(...checkedAts) : null,
        lastRunAt: lastRun?.at ?? null,
        lastRunTrigger: lastRun?.trigger ?? null,
        nextDueAt: null,
        intervalMs,
        retentionMs,
        ...computed,
        score,
        label,
        tree: tree.map(toSnapshot),
        period: { start, end, runs: runs.length },
      };
    },

    async history({ range = "24h" } = {}) {
      const at = now();
      const runs = await store.runs({ since: at - RANGES[range].durationMs, until: at });
      // One bar per scheduled run: bars as wide as the interval
      const bucketMs = bucketFor(range, intervalMs);
      return {
        schemaVersion: 1,
        range,
        bucketMs,
        bars: bucketRuns({ runs, range, now: at, scoring, bucketMs }),
      };
    },

    async serviceHistory(key, { range = "24h" } = {}) {
      if (!services.has(key)) throw new Error(`sermon-js: unknown service key: ${key}`);
      const at = now();
      const samples = await store.samples(key, { since: at - RANGES[range].durationMs, until: at });
      return { schemaVersion: 1, key, range, samples };
    },
  };

  return status;
}
