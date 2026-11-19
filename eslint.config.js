import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/drizzle/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  prettier,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "error",
    },
  },
  {
    // Dev scripts (seeds, backfills, renderers) print progress and index into data they just built.
    files: ["**/*.config.{js,ts}", "**/scripts/**", "evals/src/run.ts"],
    rules: { "no-console": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    // Tests index into fixtures they just built; a wrong index fails the test, which is the point.
    files: ["**/*.test.ts", "**/test/**"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
