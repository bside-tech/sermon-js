import type { ScoreLabel, Status } from "./types";

export type Scoring = {
  /** How much more a critical service weighs than a normal one (default 3) */
  criticalWeight: number;
  /** Value of a degraded service between 0 and 1 (default 0.6) */
  degradedValue: number;
  thresholds: {
    /** Score from which the system is "operational" (default 98) */
    operational: number;
    /** Score from which the system is "degraded" rather than "outage" (default 85) */
    degraded: number;
  };
};

export const DEFAULT_SCORING: Scoring = {
  criticalWeight: 3,
  degradedValue: 0.6,
  thresholds: { operational: 98, degraded: 85 },
};

export type ScoringInput = {
  criticalWeight?: number;
  degradedValue?: number;
  thresholds?: Partial<Scoring["thresholds"]>;
};

export function resolveScoring(input: ScoringInput = {}): Scoring {
  return {
    criticalWeight: input.criticalWeight ?? DEFAULT_SCORING.criticalWeight,
    degradedValue: input.degradedValue ?? DEFAULT_SCORING.degradedValue,
    thresholds: { ...DEFAULT_SCORING.thresholds, ...input.thresholds },
  };
}

export function labelForScore(score: number | null, scoring: Scoring = DEFAULT_SCORING): ScoreLabel {
  if (score === null) return "unknown";
  if (score >= scoring.thresholds.operational) return "operational";
  if (score >= scoring.thresholds.degraded) return "degraded";
  return "outage";
}

/**
 * Weighted share of healthy services, 0–100. Sleeping services are expected (scale to zero)
 * and count as healthy; unconfigured ones are left out. Any critical service being down
 * forces the "outage" label, whatever the number.
 */
export function computeScore({
  results,
  scoring = DEFAULT_SCORING,
}: {
  results: Array<{ status: Status; critical: boolean }>;
  scoring?: Scoring;
}): { score: number | null; label: ScoreLabel; counts: Record<Status, number> } {
  const counts: Record<Status, number> = { up: 0, degraded: 0, down: 0, sleeping: 0, unconfigured: 0 };
  const values: Record<Exclude<Status, "unconfigured">, number> = {
    up: 1,
    sleeping: 1,
    degraded: scoring.degradedValue,
    down: 0,
  };
  let weighted = 0;
  let totalWeight = 0;
  let criticalDown = false;

  for (const { status, critical } of results) {
    counts[status] += 1;
    if (status === "unconfigured") continue;
    const weight = critical ? scoring.criticalWeight : 1;
    weighted += weight * values[status];
    totalWeight += weight;
    if (critical && status === "down") criticalDown = true;
  }

  if (totalWeight === 0) return { score: null, label: "unknown", counts };
  const score = Math.round((100 * weighted) / totalWeight);
  return { score, label: criticalDown ? "outage" : labelForScore(score, scoring), counts };
}
