---
"sermon-js": minor
---

Click a history bar to see the whole page as it was then. The score, the counts and every service switch to that period: each service shows its worst result in it, with the error and per-region statuses recorded at the time, and sections that had a failing service open by themselves. A notice stays in view with the period and a "Back to live" button. New for custom pages: `status.snapshotAt({ start, end })`, the `GET /status/at` route, `client.statusAt`, `useStatusAt`, `PeriodNotice`, and `selected` / `onSelect` on `HistoryBars`. Usage bars, metrics and 24-hour statistics are only kept for the present, so they are hidden while looking at the past.
