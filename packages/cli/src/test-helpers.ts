// A test machine: temporary home, the repo's assets and a runner that answers like herdr,
// Claude Code, gh and engram installed and up to date. Each test changes only what it tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProcessRunner, type ProcessResult } from "@lunasq/server";
import { repoAssetsRoot } from "./assets.ts";
import type { MachineContext } from "./context.ts";
import { resolvePaths } from "./paths.ts";

export const HERDR_STATUS = {
  client: { version: "0.9.5", channel: "stable", protocol: 22 },
  server: { status: "running", running: true, version: "0.9.5", compatible: true },
};

export type Responses = Record<string, Partial<ProcessResult>>;

export const healthyResponses = (): Responses => ({
  "herdr status --json": { stdout: JSON.stringify(HERDR_STATUS) },
  "herdr integration status": {
    stdout:
      "pi: not installed (/h/.pi/x.ts)\nclaude: current (v11) (/h/.claude/hooks/herdr-agent-state.sh)\n",
  },
  "herdr integration install claude": { stdout: "installed" },
  "claude --version": { stdout: "2.1.314 (Claude Code)\n" },
  "copilot --version": { stdout: "GitHub Copilot CLI 1.0.105\n" },
  "gh auth status": { stdout: "✓ Logged in to github.com" },
  "command -v engram": { stdout: "/usr/local/bin/engram\n" },
});

export function fakeMachine(responses: Responses = healthyResponses()) {
  const home = mkdtempSync(join(tmpdir(), "lunasq-cli-"));
  const runner = new FakeProcessRunner(
    (input) => responses[input.command] ?? { exitCode: 127, stderr: "command not found" },
  );
  const ctx: MachineContext = {
    paths: resolvePaths({}, home),
    assetsRoot: repoAssetsRoot(),
    runner,
    nodeVersion: "26.1.0",
    checkSqlite: () => {},
  };
  return {
    home,
    ctx,
    runner,
    responses,
    /** Commands the runner ran, in order. */
    commands: () => runner.calls.map((c) => c.command),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** Writes the herdr integration state for Claude Code. */
export function integrationStatus(state: string): Partial<ProcessResult> {
  return { stdout: `claude: ${state} (/h/.claude/hooks/herdr-agent-state.sh)\n` };
}
