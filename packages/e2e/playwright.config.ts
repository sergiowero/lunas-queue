import { defineConfig } from "@playwright/test";

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 7461);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 7462);

// A single stateful server (the database, the repo, the DAG): tests run in series.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node harness/main.ts",
    url: `http://127.0.0.1:${CONTROL_PORT}/health`,
    reuseExistingServer: false,
    // SIGTERM lets the harness close the runtime and delete its temporary directory.
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { E2E_APP_PORT: String(APP_PORT), E2E_CONTROL_PORT: String(CONTROL_PORT) },
  },
});
