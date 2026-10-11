import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "examples/**/dist", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      // Core must stay runtime-agnostic: only web-standard globals
      globals: { ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // No Node built-ins in the edge-safe core (Node-only code lives in src/node)
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
      "no-restricted-globals": ["error", "process", "Buffer", "__dirname", "require"],
    },
  },
  {
    files: ["*.config.ts", "test/**/*.ts", "src/node/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-restricted-imports": "off", "no-restricted-globals": "off" },
  }
);
