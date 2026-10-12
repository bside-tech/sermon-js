---
"sermon-js": patch
---

History bars are now as wide as the check interval, so each bar holds one scheduled run: a 15-minute interval gives 15-minute bars over 24 hours instead of one filled 5-minute bar followed by two empty ones. Bars are never narrower than before (5 minutes over 24 hours, 1 hour over 7 days). `bucketFor(range, intervalMs)` is exported, and `bucketRuns` takes a `bucketMs`.
