import { defineConfig } from "vitest/config";

// Los `tests/*.spec.ts` son de Playwright (`pnpm e2e`); vitest solo corre el harness.
export default defineConfig({
  test: { name: "e2e", include: ["harness/**/*.test.ts"], testTimeout: 30_000 },
});
