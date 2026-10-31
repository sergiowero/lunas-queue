import { defineConfig } from "vitest/config";

// Los tests de git, procesos y pane reales superan los 5 s por defecto cuando varios gates corren a
// la vez (ADR verdict-git-rework). Vitest no hereda el testTimeout de la raíz hacia los proyectos.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
