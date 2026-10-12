---
"sermon-js": minor
---

Monitor specific models, and seven new presets. `anthropic` takes `track.models` and `aws.bedrock` takes `models`: each model you list gets its own row, uptime and response time, like machines under a Fly app. New presets: `neon.project` (compute states from the Neon API, never waking a suspended compute, with usage bars), `stripe` (balance, account, webhook endpoints, undelivered events, disputes), `tavily` (credits), and `exa`, `nimble` and `emelia`, which validate the key without running a billed request. A check can now name its instances with `instanceLabels`, so their table reads "Model" or "Compute" instead of "Region" and "Machine".
