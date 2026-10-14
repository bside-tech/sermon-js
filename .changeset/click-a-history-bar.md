---
"sermon-js": minor
---

Click a history bar to see what was failing then. Hovering a bar shows its details in a tooltip; once one is selected the other bars dim and lose their color, a strip under the chart names the selected period with a "Back to live" link, and a "What was failing" section appears below the main card: every service that was down or degraded in that period, with the error and per-region statuses recorded at the time. The rest of the page keeps showing the present. New for custom pages: `status.snapshotAt({ start, end })`, the `GET /status/at` route, `client.statusAt`, `useStatusAt`, `FailingServices`, and `selected` / `onSelect` on `HistoryBars`. Usage bars, metrics and 24-hour statistics are only kept for the present, so they are not part of the past view.
