# Presets

A preset is a typed function that turns a few options into a service. Every preset takes the
same five concerns: `name`, its own fields, `secrets`, `track`, `critical` (plus `description`,
`slowMs`, `timeoutMs`).

They all come from one place:

```ts
import { aws, deepgram, fly, gcp, generic, mongodb, neon, openai, statuspage } from "sermon-js/presets";
```

Presets only use `fetch` and Web Crypto, and the database presets take a client you provide,
so this entry needs nothing extra installed and works on any runtime. Bundlers drop the
presets you don't use.

A service with an empty required secret or field is listed as **not configured** and never
runs, so you can pass environment variables straight in.

Rules applied to every preset: latency above `slowMs` turns up into degraded, HTTP 429 is
degraded, timeouts and network errors are down.

## Generic

| Preset | Calls | up | degraded | down | Reports |
|---|---|---|---|---|---|
| `generic.http({ name, url, method?, headers?, body?, secrets?, track? })` | The URL | 2xx/3xx, or a status in `track.status` | 429, slow, or `track.json` says so | Other status, network error, timeout | Whatever `track.json` returns |
| `custom({ name, check, secrets? })` (from `"sermon-js"`) | Your function | `true`, nothing, or `up` | `degraded`, or slow | `false`, `down`, or a throw | Whatever you return |

## Fly.io

```ts
fly.app({ app: "my-api", secrets: { token }, track: { health: "/health" }, critical: true })
```

Checked **without ever waking a machine**: states come from the Machines API (control plane),
and the health path is only called on machines that are already running, pinned to each one
with `fly-force-instance-id`. A read-only token is enough (`fly tokens create readonly`).

| | |
|---|---|
| up | Every running machine is healthy |
| sleeping | All machines are stopped or suspended, without a crash |
| degraded | Some machines are down, a Fly health check fails, one is slow, or the Machines API can't be read |
| down | No machines, the app doesn't exist, or every machine is down (crashed, out of memory, failed, failing health) |

Reports `metrics.machines` ("2/5 running") and one `instances` row per machine (region,
machine ID, state, status, latency, error). Machines are keyed by region (`ams`, `ams#2`), so a
region's history survives deploys.

`track.health`: a path (default `"/"`), `false` for states only, or
`{ path, anyStatus: true }` to accept any HTTP answer. `track.machines: false` hides the rows.

## Google Cloud

```ts
gcp.instance({ instance: "encoder-eu", zone: "europe-west1-b", secrets: { serviceAccount }, track: { health: "http://host:8080/" } })
```

Never starts the VM: the status comes from the Compute API, and the health URL is only called
while it is RUNNING. The service account needs `compute.instances.get` (e.g. Compute Viewer).
Authentication uses Web Crypto, with no Google library.

| | |
|---|---|
| up | RUNNING (and the health URL answers) |
| sleeping | TERMINATED, STOPPED or SUSPENDED |
| degraded | PROVISIONING / STAGING, or slow |
| down | Compute API error, the health URL fails, or an unexpected state |

Reports `metrics.vm` and `metrics.zone`.

## AWS and S3-compatible storage

| Preset | Calls | Notes |
|---|---|---|
| `aws.credentials({ name, secrets: { accessKeyId, secretAccessKey } })` | STS `GetCallerIdentity` | Proves the credentials work, not that a given AWS service is healthy. For services with no cheap probe. |
| `aws.s3Bucket({ bucket, endpoint?, region?, secrets })` | `HeadBucket` | Works with AWS S3, Tigris, Cloudflare R2, MinIO. down when missing or denied. |
| `aws.bedrock({ region, models, secrets: { bearerToken } \| { accessKeyId, secretAccessKey } })` | `InvokeModel` with one token, per model | One `instances` row per model you list (model or inference-profile IDs). degraded when some fail or one is throttled, down when all fail. Uses a Bedrock API key when given, otherwise SigV4. |

## Neon

```ts
neon.project({ projectId, secrets: { apiKey }, query: (sql) => pool.query(sql), track: { compute: { maxHours: 190 }, storage: { maxGb: 10 } } })
```

Checked **without ever waking a compute**: states come from the Neon API (control plane), and
`query` only sends `select 1` while its compute is already active. `endpoint` names the compute
`query` connects to (the `ep-…` part of the connection host); by default it is the read-write
compute of the default branch.

| | |
|---|---|
| up | The compute is active (and answers `select 1` when `query` is given) |
| sleeping | The compute is suspended (scale to zero) |
| degraded | A compute is starting, a usage bar is near its limit, or the Neon API can't be read |
| down | The project doesn't exist, it has no compute, or an active compute doesn't answer |

Reports one `instances` row per compute (branch, region, state), `metrics.postgres`,
`metrics.region`, `metrics.branches`, `metrics.computes`, and `usage` bars for the allowances
you give in `track` (the API doesn't return your plan's limits): compute in CU-hours for the
billing period, storage as the sum of the branches' logical sizes.

For a plain connection check on any PostgreSQL server, including Neon, see `postgres.ping`.

## Providers

One cheap, read-only call each unless noted. All take `secrets` and are up when the key works,
down when it is rejected.

| Preset | Calls | Extra |
|---|---|---|
| `deepgram({ secrets: { apiKey }, track?: { balance } })` | Projects, then balances | `metrics.balance`; degraded below `balance.warnBelow` (20) |
| `gladia`, `gemini`, `cambai` (`secrets: { apiKey }`) | List live sessions / models / languages | |
| `anthropic({ secrets: { apiKey }, track?: { models } })` | Models (limit 1), or each model in `track.models` (free) | With `models`: one `instances` row per model; degraded when some are missing or retired, or the API is overloaded; down when none is available. Only the models you list are checked |
| `speechmatics({ secrets: { apiKey }, baseUrl? })` | Batch jobs (limit 1) | |
| `openai({ secrets: { apiKey }, organization?, track?: { model } })` | Models, or one model | Can't see billing problems |
| `elevenlabs({ secrets: { apiKey }, track?: { quota } })` | `/v1/user/subscription` | `usage`: credits with reset time; `metrics.tier`; degraded under `quota.warnBelowPct` (10) left. A key without the user scope still counts as up |
| `vercel.aiGateway({ secrets: { apiKey }, track?: { credits } })` | `/v1/credits` | `metrics.balance`, `metrics.used`; degraded below `credits.warnBelow` (5 USD). `credits: false` lists models instead |
| `vercel.blob({ secrets: { token } })` | Blobs (limit 1) | The store's read-write token |
| `deepl({ secrets: { apiKey }, track?: { quota } })` | `/v2/usage` | `usage`: characters; degraded at `quota.warnAbovePct` (90) |
| `azureTranslator({ secrets: { apiKey }, region? })` | Translates one character | |
| `googleTranslate({ secrets: { serviceAccount } })` | Token, then v3 `supportedLanguages` | `metrics.languages`. The secret is the service-account JSON, not an API key |
| `mux({ secrets: { tokenId, tokenSecret } })` | Live streams (limit 1) | |
| `cloudflareStream({ accountId, secrets: { token }, track?: { storage } })` | Videos and `storage-usage`, in parallel | `usage`: storage minutes; `metrics.videos`; degraded at 90% |
| `mailersend({ secrets: { apiKey } })` | `/v1/api-quota` | `usage`: API requests with reset time; degraded under 10% left |
| `stripe({ secrets: { apiKey }, track?: { account, webhooks, disputes } })` | Balance, then account, webhook endpoints, undelivered events (24 h) and disputes, in parallel | See below |
| `tavily({ secrets: { apiKey }, track?: { quota } })` | `/usage` | `usage`: credits (the key's limit, else the plan's); `metrics.plan`; degraded at `quota.warnAbovePct` (90) |
| `exa`, `nimble` (`secrets: { apiKey }`) | An empty search, refused for validation once the key is accepted | Nothing is searched or billed. 402 (out of credits) is degraded |
| `emelia({ secrets: { apiKey }, baseUrl? })` | An empty email-finder request, refused for validation | Nothing is looked up or billed. 402 is degraded |
| `resend({ secrets: { apiKey } })` | Domains | `metrics.domains`, `metrics.verified`; degraded when none is verified. A sending-only key still counts as up |
| `meilisearch({ host, index?, secrets: { apiKey } })` | `/health`, then the index (or the list of indexes), and its statistics | `metrics.documents`, `metrics.indexing`, when the key may read statistics. degraded when the index is missing |
| `github({ secrets: { token }, track?: { repo, rateLimit } })` | `/rate_limit` (free), optionally a repo's releases | `usage`: requests this hour; down if the repo can't be read |
| `revolut({ secrets: { apiKey }, environment? })` | Merchant orders (limit 1) | `environment: "sandbox"` for the sandbox API |
| `attendee({ secrets: { apiKey }, baseUrl? })` | Bots (page size 1) | |
| `axiom({ dataset, secrets: { token }, edge? })` | Ingests an empty batch | Writes nothing |
| `upstashRedis({ url, secrets: { token } })` | `PING` over REST | Upstash, Vercel KV and compatible servers |
| `pusher({ appId, cluster?, secrets: { key, secret }, track?: { connections } })` | Channel list, then each channel's `subscription_count` | See below |
| `statuspage({ url, name? })` | `/api/v2/status.json` | Any Atlassian Statuspage (Fly.io, Vercel, Cloudflare, GitHub…): none → up, minor → degraded, major/critical → down |

### Stripe

All calls are free and read-only. The balance validates the key; the rest is on by default
and can be turned off in `track`.

- degraded when a webhook endpoint is disabled (Stripe disables them after repeated failures),
  when Stripe could not deliver events in the last 24 hours, or when a **live** account can't
  take charges or payouts or has overdue requirements. Test-mode accounts are not held to the
  account rules.
- Reports `metrics.mode` (live/test), `metrics.available`, `metrics.pending`,
  `metrics.webhookEndpoints`, `metrics.undelivered24h`, `metrics.openDisputes`, and one
  `instances` row per webhook endpoint.
- A restricted key needs read access to what you track. What it may not read is left out,
  never counted as a failure.

### Pusher

Pusher has no usage API, so connections are **estimated** by summing subscription counts
(enable "subscription counting" in the app settings). Clients on several channels make the
estimate run slightly high, which is the safe direction for a quota alert. Set
`track.connections.max` to your plan's limit to get two usage bars (connections now, peak
today); the daily peak (UTC) is kept in the store's cache. degraded when today's peak reaches
`warnAbovePct` (90) of the limit, or when subscription counting is off. Message counts aren't
available from Pusher.

## Databases

These take a client you created, so the library never imports a database driver.

| Preset | Calls | Notes |
|---|---|---|
| `mongodb.ping({ client })` | `ping` command | `client` is your `MongoClient` or a `Db`. Pass `secrets: { url }` as well if you want the connection string redacted from errors. |
| `redis.ping({ client })` | `PING` | A connected ioredis or node-redis client. For Upstash or Vercel KV over REST, use `upstashRedis`, which needs no client. |
| `postgres.ping({ query })` | `select 1` | `query` runs one statement with your driver: `(sql) => pool.query(sql)` for pg, `(sql) => sql.query(sql)` for Neon. Pass `secrets: { url }` as well to redact the connection string. |

```ts
import { MongoClient } from "mongodb";

const url = process.env.MONGODB_URL;
mongodb.ping({
  // Not configured (and never run) while the variable is unset
  client: url ? new MongoClient(url, { serverSelectionTimeoutMS: 8000 }) : undefined,
  secrets: { url },
  critical: true,
});
```

## Testing your own presets

```ts
import { mockFetch, runCheck } from "sermon-js/testing";

const fetch = mockFetch([{ url: "/health", status: 200 }]);
const result = await runCheck(myPreset({ … }), { fetch });
expect(result.status).toBe("up");
expect(fetch.calls).toHaveLength(1);
```

`runCheck` runs a service exactly as the engine does (shared rules, timing, redaction).
