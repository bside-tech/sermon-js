import { describe, expect, it } from "vitest";
import { computeScore, labelForScore, resolveScoring } from "../src/score";

describe("computeScore", () => {
  it("returns unknown when nothing is configured", () => {
    expect(computeScore({ results: [{ status: "unconfigured", critical: true }] })).toMatchObject({
      score: null,
      label: "unknown",
    });
  });

  it("treats sleeping as healthy and ignores unconfigured", () => {
    const { score, label, counts } = computeScore({
      results: [
        { status: "up", critical: true },
        { status: "sleeping", critical: false },
        { status: "unconfigured", critical: false },
      ],
    });
    expect(score).toBe(100);
    expect(label).toBe("operational");
    expect(counts).toMatchObject({ up: 1, sleeping: 1, unconfigured: 1 });
  });

  it("weights critical services 3x by default", () => {
    // 1 critical down (w3, v0) + 3 normal up (w1, v1) → 3/6 = 50
    const { score } = computeScore({
      results: [
        { status: "down", critical: true },
        { status: "up", critical: false },
        { status: "up", critical: false },
        { status: "up", critical: false },
      ],
    });
    expect(score).toBe(50);
  });

  it("forces outage when a critical service is down, whatever the number", () => {
    const results = [
      ...Array.from({ length: 60 }, () => ({ status: "up" as const, critical: false })),
      { status: "down" as const, critical: true },
    ];
    const { score, label } = computeScore({ results });
    expect(score).toBeGreaterThanOrEqual(95);
    expect(label).toBe("outage");
  });

  it("counts degraded as partial", () => {
    expect(computeScore({ results: [{ status: "degraded", critical: false }] }).score).toBe(60);
  });

  it("honours custom weights, values and thresholds", () => {
    const scoring = resolveScoring({ criticalWeight: 1, degradedValue: 0.5, thresholds: { operational: 90 } });
    const { score, label } = computeScore({
      scoring,
      results: [
        { status: "degraded", critical: true },
        { status: "up", critical: false },
        { status: "up", critical: false },
        { status: "up", critical: false },
        { status: "up", critical: false },
      ],
    });
    expect(score).toBe(90);
    expect(label).toBe("operational");
    expect(scoring.thresholds.degraded).toBe(85);
  });

  it("labels thresholds", () => {
    expect(labelForScore(98)).toBe("operational");
    expect(labelForScore(90)).toBe("degraded");
    expect(labelForScore(50)).toBe("outage");
    expect(labelForScore(null)).toBe("unknown");
  });
});
