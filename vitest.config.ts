import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "assets/*",
      { test: { name: "tooling", include: ["tooling/**/*.test.ts"] } },
    ],
  },
});
