import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per public subpath (see "exports" in package.json)
  entry: {
    index: "src/index.ts",
    "api/index": "src/api/index.ts",
    "stores/upstash": "src/stores/upstash.ts",
    "stores/redis": "src/stores/redis.ts",
    "testing/index": "src/testing/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  target: "es2022",
});
