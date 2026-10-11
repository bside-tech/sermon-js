import type { CheckSample, LockResult, RunSummary, StatusStore } from "../store";
import type { CheckResult } from "../types";

/**
 * In-memory store: the default when no store is given. History lives only as long as the
 * process, so use a persistent store on serverless platforms.
 */
export function memoryStore({ now = () => Date.now() }: { now?: () => number } = {}): StatusStore {
  let latest: Record<string, CheckResult> = {};
  let runs: RunSummary[] = [];
  const samples = new Map<string, CheckSample[]>();
  const locks = new Map<string, number>();
  const cache = new Map<string, { value: string; expiresAt: number }>();

  return {
    async saveRun(run) {
      for (const result of run.results) latest[result.key] = result;
      for (const sample of run.samples) {
        const list = samples.get(sample.key) ?? [];
        list.push(sample);
        samples.set(sample.key, list);
      }
      runs.push(run.summary);
    },

    async latest() {
      return { ...latest };
    },

    async runs({ since, until }) {
      return runs.filter((run) => run.at >= since && run.at <= until).sort((a, b) => a.at - b.at);
    },

    async samples(key, { since, until }) {
      return (samples.get(key) ?? [])
        .filter((sample) => sample.at >= since && sample.at <= until)
        .sort((a, b) => a.at - b.at);
    },

    async prune({ before, keepKeys }) {
      runs = runs.filter((run) => run.at >= before);
      for (const [key, list] of samples) {
        const kept = list.filter((sample) => sample.at >= before);
        if (kept.length) samples.set(key, kept);
        else samples.delete(key);
      }
      if (keepKeys) {
        const keep = new Set(keepKeys);
        latest = Object.fromEntries(Object.entries(latest).filter(([key]) => keep.has(key)));
        for (const key of [...samples.keys()]) if (!keep.has(key)) samples.delete(key);
      }
    },

    async lock(name, ttlMs): Promise<LockResult> {
      const current = now();
      const expiresAt = locks.get(name);
      if (expiresAt !== undefined && expiresAt > current) {
        return { ok: false, retryAfterMs: expiresAt - current };
      }
      locks.set(name, current + ttlMs);
      return { ok: true };
    },

    async unlock(name) {
      locks.delete(name);
    },

    cache: {
      async get(key) {
        const entry = cache.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now()) {
          cache.delete(key);
          return null;
        }
        return entry.value;
      },
      async set(key, value, ttlMs) {
        cache.set(key, { value, expiresAt: now() + ttlMs });
      },
    },
  };
}
