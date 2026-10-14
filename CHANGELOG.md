# sermon-js

## 0.5.1

### Patch Changes

- f1c8413: Documentation brought up to date: the npm page no longer calls the library unreleased, and the README and guides now cover clicking history bars, public and full views with your own sign-in, and the related handler options and hooks.

## 0.5.0

### Minor Changes

- 6f30bd2: Public and full views. Give `createStatusHandler` an `access` function and the page shows anonymous visitors only the essentials (the score, the history chart and one status per top-level group) with a "Sign in" link, while viewers you allow see everything. No service names, providers, errors, timings, machines or usage reach a public visitor, history bars name groups instead of services, and on-demand runs and per-service history need the full view. Public responses stay cacheable by CDNs; full ones are private. New: `GET /viewer`, `?view=full`, `useViewer`, `client.withView`, `toPublicSnapshot`, `toPublicHistory` and `componentStatus`.

## 0.4.0

### Minor Changes

- b6b9797: Click a history bar to see what was failing then. Hovering a bar shows its details in a tooltip; once one is selected the other bars dim and lose their color, a strip under the chart names the selected period with a "Back to live" link, and a "What was failing" section appears below the main card: every service that was down or degraded in that period, with the error and per-region statuses recorded at the time. The rest of the page keeps showing the present. New for custom pages: `status.snapshotAt({ start, end })`, the `GET /status/at` route, `client.statusAt`, `useStatusAt`, `FailingServices`, and `selected` / `onSelect` on `HistoryBars`. Usage bars, metrics and 24-hour statistics are only kept for the present, so they are not part of the past view.

## 0.3.1

### Patch Changes

- 7a06e5b: History bars are now as wide as the check interval, so each bar holds one scheduled run: a 15-minute interval gives 15-minute bars over 24 hours instead of one filled 5-minute bar followed by two empty ones. Bars are never narrower than before (5 minutes over 24 hours, 1 hour over 7 days). `bucketFor(range, intervalMs)` is exported, and `bucketRuns` takes a `bucketMs`.

## 0.3.0

### Minor Changes

- 532ed83: Monitor specific models, and seven new presets. `anthropic` takes `track.models` and `aws.bedrock` takes `models`: each model you list gets its own row, uptime and response time, like machines under a Fly app. New presets: `neon.project` (compute states from the Neon API, never waking a suspended compute, with usage bars), `stripe` (balance, account, webhook endpoints, undelivered events, disputes), `tavily` (credits), and `exa`, `nimble` and `emelia`, which validate the key without running a billed request. A check can now name its instances with `instanceLabels`, so their table reads "Model" or "Compute" instead of "Region" and "Machine".

## 0.2.0

### Minor Changes

- fee29ea: Six new presets: `postgres.ping` (any PostgreSQL driver), `vercel.aiGateway` (credit balance), `vercel.blob`, `meilisearch` (health, index and document count), `resend` (domains) and `elevenlabs` (credits used this period). Keys that are valid but scoped (a sending-only Resend key, an ElevenLabs key without the user scope, a Meilisearch key that can't read statistics) count as working.

## 0.1.0

### Minor Changes

- 425d979: First release: the status engine (typed presets and custom checks, scoring, history), host-agnostic scheduling, an HTTP API handler, stores for memory, Redis, SQL and MongoDB, presets for Fly.io, Google Cloud, AWS/S3 and 20 providers, and a React UI kit.
