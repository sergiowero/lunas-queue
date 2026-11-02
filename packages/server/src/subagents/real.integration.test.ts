// The 4 reviewers against real Claude Code (UW-19 criterion). Does not run in `pnpm test`:
//   pnpm --filter @lunasq/server test:claude
// Starts the Hono app on a local port, copies the reviewers from assets/agents to the
// `.claude/agents/lunasq/` of a temporary repo and opens a `claude -p` session with the dispatcher's
// hooks settings and the run token in the environment, as in a pane. To avoid spending Opus, the
// reviewers run with `LUNASQ_REVIEWER_MODEL` (haiku by default); `opus` tests the files as
// they are.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunSubagentRepository } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { REVIEWER_NAMES, RUN_ENV } from "@lunasq/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { ensureHookSettings } from "../dispatcher/hook-settings.ts";
import { runClaude, serve } from "../test-helpers/real-claude.ts";
import { SUBAGENT_HOOK_PATH } from "./routes.ts";

const enabled = process.env.LUNASQ_CLAUDE_INTEGRATION === "1";
const reviewerModel = process.env.LUNASQ_REVIEWER_MODEL ?? "haiku";
const agentsDir = new URL("../../../../assets/agents/lunasq/", import.meta.url);

describe.skipIf(!enabled)("revisores contra Claude Code real", { timeout: 600_000 }, () => {
  let dir: string;
  let server: Server;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lunasq-reviewers-"));
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("a session launches the 4 reviewers and LunasQ records each execution in its Run", async () => {
    const db = migratedDatabase();
    // Like the dispatcher's claim: native session id, so the endpoint requires that session.
    const sessionId = randomUUID();
    const run = insertRun(db, insertTask(db, insertProject(db).id).id, {
      phase: "verify",
      agentSession: sessionId,
      agentSessionSource: "native",
    });
    server = await serve(createApp({ db }).fetch);
    const { port } = server.address() as AddressInfo;

    const repo = join(dir, "repo");
    const installed = join(repo, ".claude", "agents", "lunasq");
    mkdirSync(installed, { recursive: true });
    for (const file of readdirSync(agentsDir)) {
      const text = readFileSync(new URL(file, agentsDir), "utf8");
      writeFileSync(join(installed, file), text.replace(/^model: .*$/m, `model: ${reviewerModel}`));
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    writeFileSync(join(repo, "suma.js"), "export const suma = (a, b) => a + b;\n");
    git("add", "suma.js");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "AC-1: suma");

    const settings = join(dir, "settings.json");
    await ensureHookSettings(settings, `http://127.0.0.1:${port}${SUBAGENT_HOOK_PATH}`);
    const prompt = [
      `Launch these 4 subagents in parallel, with the Agent tool and by name: ${REVIEWER_NAMES.join(", ")}.`,
      "Tell each one: «Spec: AC-1, sum(a, b) returns a + b. Review only the diff of `git diff HEAD~1 HEAD`.»",
      "Wait for the 4 reports and answer with them, one per reviewer.",
    ].join(" ");
    const output = await runClaude(
      repo,
      [
        "-p",
        prompt,
        "--model",
        "haiku",
        "--settings",
        settings,
        "--strict-mcp-config",
        "--session-id",
        sessionId,
      ],
      { [RUN_ENV.runToken]: run.runToken, CLAUDE_CODE_FORK_SUBAGENT: "0" },
    );

    const recorded = new RunSubagentRepository(db).forRun(run.id);
    expect(recorded.map((r) => r.agentType).sort(), output).toEqual([...REVIEWER_NAMES].sort());
    for (const row of recorded) {
      expect(row.startedAt, row.agentType).toBeInstanceOf(Date);
      expect(row.stoppedAt, row.agentType).toBeInstanceOf(Date);
      expect(row.transcriptPath, row.agentType).toMatch(/\.jsonl$/);
    }
  });
});
