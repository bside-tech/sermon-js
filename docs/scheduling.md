# Scheduling

sermon-js assumes nothing about where you host. Scheduling is built on one idempotent call:

```ts
await status.tick();
// → { ran: true, report } | { ran: false, reason: "not-due" | "locked", nextDueAt }
```

`tick()` runs every service **only if a full run is due** (the last one is older than
`interval`, 5 minutes by default) and never twice at once, even across several instances that
share a store. So triggers can fire more often than the interval, irregularly, or from several
places at once. Pick whatever your platform offers; combine them freely.

The snapshot exposes `lastRunAt`, `lastRunTrigger`, `nextDueAt` and `intervalMs`, so a page can
show when its data is stale, which is how you notice a scheduler that stopped firing.

> **History needs a persistent store on serverless platforms.** The default in-memory store
> lives and dies with one function instance.

## Any external scheduler: call `/tick`

`GET` or `POST {basePath}/tick` on the HTTP handler. Set a `secret` to restrict it:

```ts
createStatusHandler(status, { secret: process.env.TICK_SECRET });
```

Send the secret as `Authorization: Bearer <secret>`, `x-sermon-secret: <secret>` or
`?key=<secret>`. Without a secret the route is public but harmless: it only runs when due.
Callers holding the secret can add `?force=1` to run regardless.

Works with cron-job.org and similar services, uptime monitors, system cron
(`*/5 * * * * curl -fsS -H "Authorization: Bearer $TICK_SECRET" https://status.example.com/api/tick`)
and Kubernetes CronJobs.

### GitHub Actions

```yaml
# .github/workflows/status-tick.yml
on:
  schedule:
    - cron: "*/5 * * * *"
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -H "Authorization: Bearer ${{ secrets.TICK_SECRET }}" https://status.example.com/api/tick
```

(GitHub's scheduler can run late under load; `tick()` copes with that.)

### Vercel Cron

```json
{ "crons": [{ "path": "/api/tick", "schedule": "*/5 * * * *" }] }
```

Set `CRON_SECRET` in the project: Vercel then sends `Authorization: Bearer $CRON_SECRET`, so
pass `secret: process.env.CRON_SECRET` to the handler.

## Native platform schedulers: call `tick()` directly

No HTTP, no secret.

### Netlify Scheduled Functions

```ts
// netlify/functions/status-tick.ts
import type { Config } from "@netlify/functions";
import { status } from "../../status.config";

export default async () => {
  await status.tick();
  return new Response("ok");
};

export const config: Config = { schedule: "*/5 * * * *" };
```

### Cloudflare Workers

```ts
import { createStatusHandler } from "sermon-js/api";
import { makeStatus } from "./status.config";   // builds the engine from `env` bindings

export default {
  fetch: (request, env, ctx) => createStatusHandler(makeStatus(env))(request, ctx),
  scheduled: (_event, env, ctx) => ctx.waitUntil(makeStatus(env).tick()),
};
```

```toml
# wrangler.toml
[triggers]
crons = ["*/5 * * * *"]
```

### Deno Deploy

```ts
Deno.cron("status tick", "*/5 * * * *", () => status.tick().then(() => undefined));
```

## Long-running servers: `startScheduler`

For Node, Bun, Deno or containers that stay up:

```ts
import { startScheduler } from "sermon-js";

const scheduler = startScheduler(status, { onError: console.error });
// scheduler.stop() on shutdown
```

It ticks immediately and then every `interval` (override with `every`), with a little jitter
so replicas don't fire together. Replicas sharing a store still run the checks once per
interval.

## No scheduler at all: refresh on read

```ts
createStatusHandler(status, { refreshOnRead: true });
```

When `/status` is read and the data is stale, the handler starts a `tick()`. If the platform
provides `waitUntil` (pass it as an option, or as the handler's second argument:
`handler(request, { waitUntil })`), the response isn't delayed and the run finishes in the
background; otherwise the handler waits for the run, up to `refreshBudget` (8 s).

The page stays fresh as long as someone looks at it, but nothing is recorded while nobody
does, so history will have gaps. Use it alone for low-stakes pages, or as a safety net next to
a real scheduler.
