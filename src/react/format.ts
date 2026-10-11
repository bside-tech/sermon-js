import type { ScoreLabel, Status } from "../types";

export type Tone = "success" | "warning" | "danger" | "default" | "accent";

export const STATUS_TONE: Record<Status, Tone> = {
  up: "success",
  degraded: "warning",
  down: "danger",
  sleeping: "accent",
  unconfigured: "default",
};

export const STATUS_TEXT: Record<Status, string> = {
  up: "Operational",
  degraded: "Degraded",
  down: "Down",
  sleeping: "Asleep (expected)",
  unconfigured: "Not configured",
};

export const LABEL_TONE: Record<ScoreLabel, Tone> = {
  operational: "success",
  degraded: "warning",
  outage: "danger",
  unknown: "default",
};

export const LABEL_TEXT: Record<ScoreLabel, string> = {
  operational: "All systems operational",
  degraded: "Degraded performance",
  outage: "Major outage",
  unknown: "No data yet",
};

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(timestamp: number, now = Date.now()) {
  const seconds = Math.round((timestamp - now) / 1000);
  if (Math.abs(seconds) < 60) return relative.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  return relative.format(Math.round(hours / 24), "day");
}

export function formatMs(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "–";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

export function formatPct(pct: number | null | undefined) {
  if (pct === null || pct === undefined) return "–";
  return `${pct.toFixed(pct === 100 ? 0 : 2)}%`;
}

const dateTime = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function formatDateTime(timestamp: number) {
  return dateTime.format(timestamp);
}

/** A duration in words: 300000 → "5 minutes" */
export function formatDuration(ms: number) {
  const units: Array<[number, string]> = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1000, "second"],
  ];
  for (const [size, name] of units) {
    if (ms >= size) {
      const count = Math.round(ms / size);
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return `${ms} ms`;
}

/** "quotaUsed" → "Quota used" */
export function humanize(key: string) {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
