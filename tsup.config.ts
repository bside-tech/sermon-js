import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

/**
 * A directive only counts at the very top of a file. The CommonJS output gets helper code
 * placed before the banner, so move `"use client"` back to the first line there.
 */
function hoistUseClient(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) hoistUseClient(path);
    else if (entry.name.endsWith(".cjs")) {
      const code = readFileSync(path, "utf8");
      if (code.includes('"use client";') && !code.startsWith('"use client";')) {
        writeFileSync(path, `"use client";\n${code.replace('"use client";', "")}`);
      }
    }
  }
}

const shared = {
  format: ["esm", "cjs"] as const,
  dts: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
  target: "es2022",
};

// One entry per public subpath (see "exports" in package.json). `dist` is emptied by the
// "prebuild" script, not here, because the two builds below run side by side.
export default defineConfig([
  {
    ...shared,
    format: [...shared.format],
    entry: {
      index: "src/index.ts",
      "api/index": "src/api/index.ts",
      "presets/index": "src/presets/index.ts",
      "stores/upstash": "src/stores/upstash.ts",
      "stores/redis": "src/stores/redis.ts",
      "stores/sql": "src/stores/sql.ts",
      "stores/mongodb": "src/stores/mongodb.ts",
      "testing/index": "src/testing/index.ts",
    },
  },
  {
    ...shared,
    format: [...shared.format],
    // The UI kit: client components, built apart so every file can carry "use client"
    entry: {
      "react/index": "src/react/index.ts",
      "react/heroui/index": "src/react/heroui/index.ts",
    },
    external: ["react", "react-dom", "react/jsx-runtime", "@tanstack/react-query", "@heroui/react"],
    // Rollup's tree-shaking pass strips module directives, so it stays off for this build
    treeshake: false,
    banner: { js: '"use client";' },
    onSuccess: async () => {
      mkdirSync("dist/react/heroui", { recursive: true });
      copyFileSync("src/react/heroui/styles.css", "dist/react/heroui/styles.css");
      hoistUseClient("dist");
    },
  },
]);
