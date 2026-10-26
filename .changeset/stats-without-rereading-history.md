---
"sermon-js": patch
---

Runs no longer read the history. Statistics used to be recomputed from every sample of the retention window after each run, and `sqlStore` and `mongoStore` pruned removed services by scanning every sample, so the rows read per run grew with the history: on Cloudflare D1, a one-minute interval reached the free plan's daily read limit within a day. Each service now keeps a small statistics window in the store's cache (its last 24 hours of samples, and the rest of the week counted per hour) and a run folds in its new samples; the history is read only to rebuild a window the cache lost. Stores without a cache keep recomputing from the history. Removed services are found among the latest results and deleted by key. The 7-day uptime's oldest edge is now counted to the hour.
