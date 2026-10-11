import { describe, expect, it } from "vitest";
import { toMs } from "../src/duration";

describe("toMs", () => {
  it("parses units", () => {
    expect(toMs("250ms")).toBe(250);
    expect(toMs("30s")).toBe(30_000);
    expect(toMs("5m")).toBe(300_000);
    expect(toMs("1h")).toBe(3_600_000);
    expect(toMs("7d")).toBe(604_800_000);
    expect(toMs(1234)).toBe(1234);
  });

  it("rejects nonsense", () => {
    expect(() => toMs("five minutes" as never)).toThrow(/Invalid duration/);
    expect(() => toMs(-1)).toThrow(/Invalid duration/);
  });
});
