import { EdgeVM } from "@edge-runtime/vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// The core must run where there is no Node: only web-standard globals (fetch, AbortController…).
// We bundle a scenario and evaluate it in a real edge sandbox, where `process` and `Buffer` don't exist.
describe("edge runtime", () => {
  it("runs a full cycle without Node globals", async () => {
    const bundle = await build({
      entryPoints: ["test/fixtures/edge-entry.ts"],
      bundle: true,
      format: "iife",
      globalName: "scenario",
      platform: "neutral",
      target: "es2022",
      write: false,
    });
    const vm = new EdgeVM();
    vm.evaluate(bundle.outputFiles[0]!.text);
    const result = JSON.parse(await vm.evaluate<Promise<string>>("scenario.run()"));

    expect(result).toEqual({
      score: 67,
      statuses: ["up", "up", "down"],
      error: "boom ***",
      label: "outage",
      bars: 288,
      tick: 200,
      viaApi: 67,
      locks: [true, false],
      presets: {
        statuspage: "degraded",
        fly: "sleeping",
        mongodb: "up",
        redis: "up",
        s3Signed: true,
        pusherSigned: true,
        googleJwtParts: 3,
      },
      nodeGlobals: ["undefined", "undefined"],
    });
  });
});
