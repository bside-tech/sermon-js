import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per public subpath (see "exports" in package.json)
  entry: {
    index: "src/index.ts",
    "api/index": "src/api/index.ts",
    "fly/index": "src/fly/index.ts",
    "gcp/index": "src/gcp/index.ts",
    "aws/index": "src/aws/index.ts",
    "providers/index": "src/providers/index.ts",
    "node/index": "src/node/index.ts",
    "stores/upstash": "src/stores/upstash.ts",
    "stores/redis": "src/stores/redis.ts",
    "stores/sql": "src/stores/sql.ts",
    "stores/mongodb": "src/stores/mongodb.ts",
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
