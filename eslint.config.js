import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "examples/**/dist", "examples/**/node_modules", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      // Core must stay runtime-agnostic: only web-standard globals
      globals: { ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // No Node built-ins anywhere in the library: it must run on edge runtimes too
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
      "no-restricted-globals": ["error", "process", "Buffer", "__dirname", "require"],
    },
  },
  {
    files: ["src/react/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["*.config.ts", "test/**/*.{ts,tsx}", "examples/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-restricted-imports": "off", "no-restricted-globals": "off" },
  }
);
