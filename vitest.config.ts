import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/main.ts", "**/*.gen.ts", "**/scripts/**"],
      reporter: ["text-summary", "json-summary", "html"],
      // The decision logic an auditor reads is held to a higher bar than the plumbing.
      thresholds: {
        lines: 70,
        "packages/matching/src/**": { lines: 85, branches: 80 },
        "packages/contracts/src/**": { lines: 85 },
      },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["{apps,packages}/*/src/**/*.test.ts", "evals/src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["{apps,packages}/*/test/integration/**/*.test.ts"],
          globalSetup: ["./test/global-setup.ts"],
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
