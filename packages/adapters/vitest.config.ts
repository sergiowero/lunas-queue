import { defineConfig } from "vitest/config";

// Timeouts of the real git, process and pane tests exceed the default 5 s when several gates run at the
// same time (ADR verdict-git-rework). Vitest does not inherit the root's testTimeout from the projects.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
