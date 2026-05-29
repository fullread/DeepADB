import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Flat config. Lints the TypeScript sources in src/ only; build output, tests
// (standalone .mjs harness suites), and coverage are out of scope.
export default tseslint.config(
  {
    ignores: ["build/**", "coverage/**", "node_modules/**", "tests/**", "eslint.config.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
    },
    rules: {
      // Honor the underscore-prefix convention for intentionally-unused
      // bindings (interface-mandated params, destructure placeholders).
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
);
