# Stores

A store keeps history: the latest result of each service, one sample per service per run, and
one summary per run. Statistics (uptime, percentiles) and history buckets are computed by the
library from what the store returns, so stores only save and read rows.

Persistence is optional. Without a `store`, history lives in memory for as long as the process
does: fine for a long-running server you don't mind starting empty, not for serverless.

```ts
defineStatus({ store: …, retention: "7d", services });
```

Old runs and samples are pruned after each full run, along with the data of services you
removed from the configuration.

## Redis

```ts
import { upstashStore } from "sermon-js/stores/upstash";
upstashStore({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN, prefix: "sermon" });
```

Upstash Redis and Vercel KV, over their REST API. It only uses `fetch`, so it runs on
serverless and edge runtimes with nothing to install.

```ts
import { redisStore } from "sermon-js/stores/redis";
redisStore({ client: new Redis(process.env.REDIS_URL) });         // ioredis
redisStore({ client: await createClient({ url }).connect() });    // node-redis
redisStore({ command: (args) => myClient.send(args) });           // anything else
```

Any Redis-compatible server (Redis, Valkey, KeyDB, Dragonfly), through the client you already
have. Keys live under `prefix` (default `sermon`), so several status pages can share a database.

## SQL: PostgreSQL, MySQL / MariaDB, SQLite

```ts
import { sqlStore } from "sermon-js/stores/sql";
```

You provide one `query(sql, params)` function that resolves with rows, using your own driver:

```ts
// PostgreSQL (pg)
sqlStore({ dialect: "postgres", query: async (sql, params) => (await pool.query(sql, params)).rows });

// MySQL / MariaDB (mysql2)
sqlStore({
  dialect: "mysql",
  query: async (sql, params) => {
    const [rows] = await pool.query(sql, params);
    return Array.isArray(rows) ? rows : [];
  },
});

// SQLite (better-sqlite3)
sqlStore({
  dialect: "sqlite",
  query: async (sql, params) => {
    const statement = db.prepare(sql);
    if (statement.reader) return statement.all(...params);
    statement.run(...params);
    return [];
  },
});
```

The same shape works for Neon, PlanetScale, Turso/libSQL, D1, Drizzle's or Prisma's raw
queries: anything that runs a statement with positional parameters.

It uses four tables (`sermon_latest`, `sermon_runs`, `sermon_samples`, `sermon_kv`; change the
prefix with `tablePrefix`) and creates them on first use. To manage the schema yourself, pass
`autoMigrate: false` and run `await store.migrate()`, or feed `store.schema` (the list of
`CREATE` statements) to your migration tool.

## MongoDB

```ts
import { mongoStore } from "sermon-js/stores/mongodb";
mongoStore({ db: client.db("status") });
```

Four collections (prefix `sermon_`, change it with `collectionPrefix`); indexes are created on
first use.

## Writing your own

Implement [`StatusStore`](../src/store.ts): five required methods, plus optional locks and a
small cache.

```ts
interface StatusStore {
  saveRun(run: { summary: RunSummary; results: CheckResult[]; samples: CheckSample[] }): Promise<void>;
  latest(): Promise<Record<string, CheckResult>>;
  runs(range: { since: number; until: number }): Promise<RunSummary[]>;        // inclusive, oldest first
  samples(key: string, range: { since: number; until: number }): Promise<CheckSample[]>;
  prune(options: { before: number; keepKeys?: string[] }): Promise<void>;

  lock?(name: string, ttlMs: number): Promise<{ ok: true } | { ok: false; retryAfterMs: number }>;
  unlock?(name: string): Promise<void>;
  cache?: { get(key: string): Promise<string | null>; set(key: string, value: string, ttlMs: number): Promise<void> };
}
```

- Without `lock`, the library uses an in-process lock: enough for one server, not for several
  instances sharing the store (they could run the checks twice, or let rate limits through).
- Without `cache`, statistics are recomputed in memory and checks that keep state (such as
  Pusher's daily peak) lose it on restart.

Check your implementation with the same suite the built-in stores pass:

```ts
import { describe, expect, it } from "vitest";            // or Jest
import { runStoreConformance } from "sermon-js/testing";

runStoreConformance("my store", () => myStore(freshDatabase()), { describe, it, expect });
```
