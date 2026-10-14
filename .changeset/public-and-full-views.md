---
"sermon-js": minor
---

Public and full views. Give `createStatusHandler` an `access` function and the page shows anonymous visitors only the essentials (the score, the history chart and one status per top-level group) with a "Sign in" link, while viewers you allow see everything. No service names, providers, errors, timings, machines or usage reach a public visitor, history bars name groups instead of services, and on-demand runs and per-service history need the full view. Public responses stay cacheable by CDNs; full ones are private. New: `GET /viewer`, `?view=full`, `useViewer`, `client.withView`, `toPublicSnapshot`, `toPublicHistory` and `componentStatus`.
