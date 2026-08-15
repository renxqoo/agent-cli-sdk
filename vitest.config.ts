import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 75,
        branches: 68,
        functions: 80,
        lines: 77,
      },
    },
  },
});
