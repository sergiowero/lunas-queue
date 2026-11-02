import { defineConfig } from "vitest/config";

// Real git, process and pane tests exceed the default 5 s when several gates run at
// once (ADR verdict-git-rework). Vitest does not inherit the root testTimeout into the projects.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
