import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/stores/memory";
import { runStoreConformance } from "../src/testing";

runStoreConformance("memoryStore", () => memoryStore(), { describe, it, expect });

describe("runStoreConformance", () => {
  it("asks for a test harness when the runner has no globals", () => {
    expect(() => runStoreConformance("x", () => memoryStore())).toThrow(/describe, it, expect/);
  });
});
