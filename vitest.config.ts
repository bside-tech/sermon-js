import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    typecheck: { include: ["test/**/*.test-d.ts"] },
  },
});
