const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** A number of milliseconds, or a string like "30s", "5m", "1h", "7d" */
export type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

export function toMs(duration: Duration): number {
  if (typeof duration === "number") {
    if (!Number.isFinite(duration) || duration < 0) throw new Error(`Invalid duration: ${duration}`);
    return duration;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) throw new Error(`Invalid duration: "${duration}" (use e.g. "30s", "5m", "1h", "7d")`);
  return Number(match[1]) * UNITS[match[2] as string]!;
}
