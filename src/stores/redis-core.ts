import type { CheckSample, LockResult, RunSummary, StatusStore } from "../store";
import type { CheckResult } from "../types";

export type RedisCommand = Array<string | number>;

/** Runs a batch of Redis commands and returns their replies in order */
export type RedisExec = (commands: RedisCommand[]) => Promise<unknown[]>;

function parse<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return value && typeof value === "object" ? (value as T) : undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** HGETALL replies as a flat [field, value, …] array (RESP2, REST) or as an object (RESP3) */
function toRecord(reply: unknown): Record<string, unknown> {
  if (!reply) return {};
  if (Array.isArray(reply)) {
    const record: Record<string, unknown> = {};
    for (let i = 0; i + 1 < reply.length; i += 2) record[String(reply[i])] = reply[i + 1];
    return record;
  }
  if (reply instanceof Map) return Object.fromEntries(reply);
  return reply as Record<string, unknown>;
}

const list = (reply: unknown): unknown[] => (Array.isArray(reply) ? reply : []);

/**
 * A `StatusStore` on top of plain Redis commands. Layout, under `prefix`:
 * - `latest`         HASH   service key → latest result (JSON)
 * - `runs`           ZSET   run summaries (JSON), scored by time
 * - `samples:<key>`  ZSET   samples of one service (JSON), scored by time
 * - `lock:<name>`, `cache:<key>`  strings with a time-to-live
 */
export function createRedisStore({ exec, prefix = "sermon" }: { exec: RedisExec; prefix?: string }): StatusStore {
  const k = {
    latest: `${prefix}:latest`,
    runs: `${prefix}:runs`,
    samples: (key: string) => `${prefix}:samples:${key}`,
    lock: (name: string) => `${prefix}:lock:${name}`,
    cache: (key: string) => `${prefix}:cache:${key}`,
  };
  const one = async (command: RedisCommand) => (await exec([command]))[0];

  return {
    async saveRun({ summary, results, samples }) {
      const commands: RedisCommand[] = [];
      if (results.length) {
        commands.push(["HSET", k.latest, ...results.flatMap((result) => [result.key, JSON.stringify(result)])]);
      }
      for (const sample of samples) {
        commands.push(["ZADD", k.samples(sample.key), sample.at, JSON.stringify(sample)]);
      }
      commands.push(["ZADD", k.runs, summary.at, JSON.stringify(summary)]);
      await exec(commands);
    },

    async latest() {
      const record = toRecord(await one(["HGETALL", k.latest]));
      const latest: Record<string, CheckResult> = {};
      for (const [key, value] of Object.entries(record)) {
        const result = parse<CheckResult>(value);
        if (result) latest[key] = result;
      }
      return latest;
    },

    async runs({ since, until }) {
      const reply = await one(["ZRANGEBYSCORE", k.runs, since, until]);
      return list(reply)
        .map((member) => parse<RunSummary>(member))
        .filter((run): run is RunSummary => !!run);
    },

    async samples(key, { since, until }) {
      const reply = await one(["ZRANGEBYSCORE", k.samples(key), since, until]);
      return list(reply)
        .map((member) => parse<CheckSample>(member))
        .filter((sample): sample is CheckSample => !!sample);
    },

    async prune({ before, keepKeys }) {
      const keys = list(await one(["HKEYS", k.latest])).map(String);
      // "(" makes the bound exclusive: entries exactly at `before` are kept
      const commands: RedisCommand[] = [
        ["ZREMRANGEBYSCORE", k.runs, "-inf", `(${before}`],
        ...keys.map((key): RedisCommand => ["ZREMRANGEBYSCORE", k.samples(key), "-inf", `(${before}`]),
      ];
      if (keepKeys) {
        const keep = new Set(keepKeys);
        const removed = keys.filter((key) => !keep.has(key));
        if (removed.length) {
          commands.push(["HDEL", k.latest, ...removed], ["DEL", ...removed.map(k.samples)]);
        }
      }
      await exec(commands);
    },

    async lock(name, ttlMs): Promise<LockResult> {
      const ttl = Math.max(1, Math.round(ttlMs));
      const acquired = await one(["SET", k.lock(name), "1", "NX", "PX", ttl]);
      if (acquired) return { ok: true };
      const remaining = Number(await one(["PTTL", k.lock(name)]));
      return { ok: false, retryAfterMs: remaining > 0 ? remaining : ttl };
    },

    async unlock(name) {
      await one(["DEL", k.lock(name)]);
    },

    cache: {
      async get(key) {
        const value = await one(["GET", k.cache(key)]);
        return typeof value === "string" ? value : value === null || value === undefined ? null : JSON.stringify(value);
      },
      async set(key, value, ttlMs) {
        await one(["SET", k.cache(key), value, "PX", Math.max(1, Math.round(ttlMs))]);
      },
    },
  };
}
