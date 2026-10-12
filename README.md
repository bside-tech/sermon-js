# sermon-js

**Ser**vice **mon**itor: everything behind a status page, as a TypeScript library.

Describe the services you depend on, and get checks, scoring, history, an HTTP API and a
ready-made page. It runs anywhere: Node, Bun, Deno, Vercel, Netlify, Cloudflare Workers.
No hosting assumptions, no required database.

> **Status: pre-release.** Everything below is built and tested; the first npm release is
> pending. See [Roadmap](#roadmap).

```bash
npm install sermon-js
```

## Quick start

```ts
import { custom, defineStatus, generic, group } from "sermon-js";
import { createStatusHandler } from "sermon-js/api";

export const status = defineStatus({
  services: [
    group({
      title: "Our services",
      services: [
        generic.http({ name: "Web app", url: process.env.WEB_URL, critical: true }),
        generic.http({
          name: "API",
          url: "https://api.example.com/health",
          secrets: { token: process.env.API_TOKEN },
          headers: (secrets) => ({ Authorization: `Bearer ${secrets.token}` }),
          critical: true,
        }),
      ],
    }),
    custom({
      name: "Queue depth",
      check: async ({ http }) => {
        const res = await http("https://queue.internal/stats");
        if (!res.ok) return res.outcome;
        const { waiting, limit } = res.json as { waiting: number; limit: number };
        return {
          status: waiting > limit * 0.9 ? "degraded" : "up",
          usage: [{ label: "Queue", used: waiting, limit, unit: "jobs" }],
        };
      },
    }),
  ],
});

// A standard (Request) => Response handler: mount it in any framework
export const handler = createStatusHandler(status);
```

Then trigger `status.tick()` on a schedule (see [Scheduling](docs/scheduling.md)) and read
`GET /api/status`.

## Describing services

`services` is a list of **presets** (see [all presets](docs/presets.md)), **custom checks** and
**groups**. Groups can nest. Every service takes the same five concerns:

| Concern | Option |
|---|---|
| How to call it | `name` |
| What it is | the function you call, plus the fields it needs (`url`, …) |
| Secrets it needs | `secrets: { … }`: redacted from everything public and from logs (see [Security](docs/security.md)) |
| What to track | `track: { … }`: options of the preset |
| Importance | `critical: true` weighs more in the score; one critical service down means "outage" |

```ts
import { deepgram, fly, statuspage } from "sermon-js/presets";

group({ title: "Platform", services: [
  // Never wakes a sleeping machine; reports each region on its own
  fly.app({ app: "my-api", secrets: { token: process.env.FLY_API_TOKEN }, critical: true }),
  deepgram({ secrets: { apiKey: process.env.DEEPGRAM_API_KEY }, track: { balance: { warnBelow: 20 } } }),
  statuspage({ name: "Fly.io", url: "https://status.flyio.net" }),
] })
```

A service whose required secret or field is empty (say, an environment variable that isn't
set yet) is listed as **not configured**: it never runs and never throws.

Services have no IDs. Keys are derived (`our-services:web-app`), unique and URL-safe.

### Custom checks

```ts
custom({
  name: "Queue depth",              // required
  description: "Jobs waiting in the worker queue",
  critical: false,
  secrets: { apiKey: process.env.QUEUE_API_KEY },   // typed inside `check`
  slowMs: 1500,                     // slower than this → degraded (default 2000)
  timeoutMs: 10_000,                // hard cap (default 10 s)
  check: async ({ secrets, http, measure, combine, signal, cache }) => { … },
});
```

`check` returns `true`/nothing (up), `false` (down), or an outcome:

```ts
type CheckOutcome = {
  status: "up" | "degraded" | "down" | "sleeping";
  latencyMs?: number;      // measured for you when omitted
  httpStatus?: number;
  error?: string;          // shown publicly: secrets are redacted, long text truncated
  metrics?: Record<string, string | number>;                        // small chips
  usage?: { label; used; limit; unit?; resetsAt? }[];               // quota bars
  instances?: { key; region?; state?; status; latencyMs?; error? }[]; // per machine/region
  instanceLabels?: { key; detail? };                                  // what the instances are: "Model", "Compute"…
  probed?: boolean;        // false when the target was deliberately not touched
};
```

Throwing means down. The helpers never throw: `http()` returns
`{ ok, status, latencyMs, json, text, outcome }` where `outcome` is ready to return.

### Statuses

| Status | Meaning | Score |
|---|---|---|
| `up` | Reachable and healthy | 1 |
| `degraded` | Working with a warning: slow, rate limited, low quota, part of its instances down | 0.6 |
| `down` | Unreachable, erroring, rejected, crashed | 0 |
| `sleeping` | Deliberately not running (scale to zero), and not probed | 1 |
| `unconfigured` | A required secret or field is empty; never run | excluded |

Applied to every service: latency above `slowMs` turns up into degraded, HTTP 429 is
degraded, timeouts and thrown errors are down.

### Writing a preset

```ts
import { definePreset, type PresetOptions } from "sermon-js";

type Options = PresetOptions & {
  app: string;
  secrets: { token: string | undefined };
  track?: { health?: string | false };
};

export const flyApp = definePreset<Options>()({
  kind: "fly.app",
  requiredSecrets: ["token"],
  derive: (o) => ({ name: o.app, identity: `fly.app:${o.app}` }),
  check: async ({ options, secrets, http }) => { … },
});
```

`identity` gives the service a natural key, so its history survives renames and moves.

## The engine

```ts
await status.tick();                      // run everything, only if due (idempotent)
await status.run();                       // run everything now
await status.run({ keys: ["queue-depth"] });
await status.snapshot();                  // tree + latest results + statistics + score
await status.history({ range: "24h" });   // score history, one bar per interval ("24h" | "7d")
await status.serviceHistory("queue-depth");
```

Options: `interval` (default `"5m"`), `retention` (`"7d"`), `scoring`, `store`, `hideResponseBodies`
(report failed answers by status code only; see [Security](docs/security.md)).

## HTTP API

```ts
createStatusHandler(status, {
  basePath: "/api",          // default
  secret: process.env.TICK_SECRET,   // protects /tick when set
  refreshOnRead: false,      // start a run when /status is read and data is stale
  rateLimits: { runAll: "60s", runOne: "20s" },
  cors: false,
});
```

| Route | |
|---|---|
| `GET /status` | Snapshot |
| `GET /history?range=24h\|7d` | Score history |
| `GET /services/:key/history` | Samples of one service |
| `POST /run`, `POST /run/:key` | On-demand runs, rate limited |
| `GET\|POST /tick` | Run if due, for schedulers |

For plain Node servers: `http.createServer(toNodeListener(handler))`.

## Stores

History is kept in memory by default, which lasts as long as the process. For anything
serverless, or to survive restarts, pass a store:

```ts
import { upstashStore } from "sermon-js/stores/upstash";   // Upstash / Vercel KV, fetch only
import { redisStore } from "sermon-js/stores/redis";       // any Redis client you already have

defineStatus({ store: upstashStore({ url, token }), services });
defineStatus({ store: redisStore({ client: new Redis(url) }), services });   // ioredis or node-redis
```

```ts
import { sqlStore } from "sermon-js/stores/sql";           // Postgres, MySQL/MariaDB, SQLite: your driver
import { mongoStore } from "sermon-js/stores/mongodb";

defineStatus({ store: sqlStore({ dialect: "postgres", query: async (sql, params) => (await pool.query(sql, params)).rows }), services });
defineStatus({ store: mongoStore({ db: client.db("status") }), services });
```

Anything else is a small interface to implement and a conformance suite to check it with.
See [Stores](docs/stores.md).

## UI

```tsx
import { StatusPage } from "sermon-js/react/heroui";

<StatusPage baseUrl="/api" brand={<Logo />} />
```

A complete page (score, history, collapsible sections, per-region details, usage bars,
on-demand checks, deep links, theme switch) on HeroUI and Tailwind, plus a headless layer of
hooks and helpers to build your own. See [UI kit](docs/ui.md) and
[`examples/vite`](examples/vite).

## Roadmap

- [x] Core: config tree, custom checks, `generic.http`, runner, scoring, history, statistics
- [x] Host-agnostic scheduling: `tick()`, `startScheduler`, `/tick`, refresh on read
- [x] HTTP API handler, Node adapter
- [x] Stores: memory, Upstash REST, any Redis client
- [x] Presets: Fly apps (sleep-safe, per region), GCP instances, Neon projects (sleep-safe), AWS/S3/Bedrock, Statuspage, Pusher, Stripe, AI/translation/video/email/search providers, Vercel, MongoDB, Redis, PostgreSQL
- [x] Stores: SQL (Postgres, MySQL/MariaDB, SQLite), MongoDB
- [x] React UI kit (headless hooks + HeroUI components)
- [ ] First npm release

## License

MIT
