# sermon-js

## 0.3.0

### Minor Changes

- 532ed83: Monitor specific models, and seven new presets. `anthropic` takes `track.models` and `aws.bedrock` takes `models`: each model you list gets its own row, uptime and response time, like machines under a Fly app. New presets: `neon.project` (compute states from the Neon API, never waking a suspended compute, with usage bars), `stripe` (balance, account, webhook endpoints, undelivered events, disputes), `tavily` (credits), and `exa`, `nimble` and `emelia`, which validate the key without running a billed request. A check can now name its instances with `instanceLabels`, so their table reads "Model" or "Compute" instead of "Region" and "Machine".

## 0.2.0

### Minor Changes

- fee29ea: Six new presets: `postgres.ping` (any PostgreSQL driver), `vercel.aiGateway` (credit balance), `vercel.blob`, `meilisearch` (health, index and document count), `resend` (domains) and `elevenlabs` (credits used this period). Keys that are valid but scoped (a sending-only Resend key, an ElevenLabs key without the user scope, a Meilisearch key that can't read statistics) count as working.

## 0.1.0

### Minor Changes

- 425d979: First release: the status engine (typed presets and custom checks, scoring, history), host-agnostic scheduling, an HTTP API handler, stores for memory, Redis, SQL and MongoDB, presets for Fly.io, Google Cloud, AWS/S3 and 20 providers, and a React UI kit.
