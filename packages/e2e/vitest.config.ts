import { defineConfig } from "vitest/config";

// The `tests/*.spec.ts` are Playwright's (`pnpm e2e`); vitest only runs the harness.
export default defineConfig({
  test: { name: "e2e", include: ["harness/**/*.test.ts"], testTimeout: 30_000 },
});
