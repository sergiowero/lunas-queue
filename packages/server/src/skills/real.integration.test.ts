// The phase skills against real Claude Code: each one produces a valid handoff
// on a test task. It does not run in `pnpm test`:
//   pnpm --filter @lunasq/server test:skills
// A single task goes through refinement, implementation and verification on a temporary repo. Each
// phase opens `claude -p` with the dispatcher's phase prompt, the LunasQ MCP via `--mcp-config`
// (no engram: `--strict-mcp-config`), the hooks settings and the run token in the environment, as
// in a pane. The test gate is the real one with a local runner instead of the herdr pane. Phases
// run with `LUNASQ_SKILL_MODEL` (sonnet by default) and reviewers with
// `LUNASQ_REVIEWER_MODEL` (haiku by default).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealGit, ShellProcessRunner } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  latestChecklist,
  migrateDatabase,
  openDatabase,
  RunRepository,
  RunSubagentRepository,
  SpecRepository,
  TaskRepository,
} from "@lunasq/db";
import { insertProject, insertRun, insertTask, setTaskPosition } from "@lunasq/db/test-helpers";
import { phasePrompt } from "@lunasq/domain";
import {
  type Handoff,
  parseHandoff,
  RUN_ENV,
  type SchedulablePhase,
  type StatePosition,
} from "@lunasq/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { ensureHookSettings } from "../dispatcher/hook-settings.ts";
import { ensureMcpConfig } from "../dispatcher/mcp-config.ts";
import { SUBAGENT_HOOK_PATH } from "../subagents/routes.ts";
import { PaneTestGate } from "../test-gate/gate.ts";
import { runClaude, serve } from "../test-helpers/real-claude.ts";

const enabled = process.env.LUNASQ_SKILLS_INTEGRATION === "1";
const skillModel = process.env.LUNASQ_SKILL_MODEL ?? "sonnet";
const reviewerModel = process.env.LUNASQ_REVIEWER_MODEL ?? "haiku";
const assets = new URL("../../../../assets/", import.meta.url);
const BRANCH = "lunasq/test";

const GOAL =
  "Add the divide(a, b) operation to the calculator in src/divide.js: it returns a / b and " +
  "rejects division by zero with an error that says so.";

describe.skipIf(!enabled)("phase skills against real Claude Code", { timeout: 1_800_000 }, () => {
  let dir: string;
  let repo: string;
  let server: Server;
  let db: LunasqDatabase;
  let taskId: string;
  let mcpConfigPath: string;
  let settingsPath: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lunasq-skills-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{ "name": "calculator", "type": "module" }\n');
    writeFileSync(join(repo, "src", "add.js"), "export const add = (a, b) => a + b;\n");
    writeFileSync(
      join(repo, "src", "add.test.js"),
      [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { add } from "./add.js";',
        "",
        'test("adding two numbers returns their sum", () => {',
        "  assert.equal(add(2, 3), 5);",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, "AGENTS.md"),
      "# Calculator\n\nDependency-free JavaScript. One file per operation in `src/`, with its test next to it (`node:test`). Tests: `node --test`.\n",
    );
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "calculator");
    // Like a LunasQ worktree: the branch starts from origin/main (ADR 0012).
    execFileSync("git", ["init", "-q", "--bare", join(dir, "origin.git")]);
    git("remote", "add", "origin", join(dir, "origin.git"));
    git("push", "-q", "origin", "main");
    git("fetch", "-q", "origin");
    git("checkout", "-q", "-b", BRANCH, "origin/main");
    git("config", "user.name", "LunasQ test");
    git("config", "user.email", "test@lunasq.local");
    // What `lunasq install` installs lives outside the task tree: it does not dirty the worktree.
    appendFileSync(join(repo, ".git", "info", "exclude"), ".claude/\n");
    for (const skill of readdirSync(new URL("skills/", assets), { withFileTypes: true })) {
      if (!skill.isDirectory() || skill.name === "node_modules") continue;
      cpSync(
        new URL(`skills/${skill.name}/`, assets),
        join(repo, ".claude", "skills", skill.name),
        {
          recursive: true,
        },
      );
    }
    const agents = join(repo, ".claude", "agents", "lunasq");
    mkdirSync(agents, { recursive: true });
    for (const file of readdirSync(new URL("agents/lunasq/", assets))) {
      const text = readFileSync(new URL(`agents/lunasq/${file}`, assets), "utf8");
      writeFileSync(join(agents, file), text.replace(/^model: .*$/m, `model: ${reviewerModel}`));
    }

    // Opened by hand: the test-helpers ones close in every afterEach and here the phases share it.
    db = openDatabase(join(dir, "lunasq.db"));
    migrateDatabase(db);
    const project = insertProject(db, { localPath: repo, testCommand: "node --test" });
    taskId = insertTask(db, project.id, {
      goal: GOAL,
      branch: BRANCH,
      worktreePath: repo,
    }).id;
    const testGate = new PaneTestGate({
      db,
      git: new RealGit(),
      worktrees: {
        ensure: async () => ({
          branch: BRANCH,
          path: repo,
          workspaceId: "local",
          rootPaneId: "local",
          created: false,
        }),
      },
      runnerFor: () => new ShellProcessRunner(),
    });
    server = await serve(createApp({ db, testGate }).fetch);
    const { port } = server.address() as AddressInfo;
    mcpConfigPath = join(dir, "mcp.json");
    settingsPath = join(dir, "settings.json");
    await ensureMcpConfig(mcpConfigPath, `http://127.0.0.1:${port}/mcp`);
    await ensureHookSettings(settingsPath, `http://127.0.0.1:${port}${SUBAGENT_HOOK_PATH}`);
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    db?.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Dispatches the phase like the dispatcher (Run with native session id, phase prompt) and waits. */
  async function dispatch(phase: SchedulablePhase, position: StatePosition) {
    setTaskPosition(db, taskId, position);
    const sessionId = randomUUID();
    const run = insertRun(db, taskId, {
      phase,
      agentSession: sessionId,
      agentSessionSource: "native",
    });
    const output = await runClaude(
      repo,
      [
        "-p",
        phasePrompt(phase, taskId),
        "--model",
        skillModel,
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
        "--settings",
        settingsPath,
        "--setting-sources",
        "project",
        "--allowedTools",
        "mcp__lunasq",
        "Bash",
        "Read",
        "Edit",
        "Write",
        "Grep",
        "Glob",
        "Agent",
        "Skill",
        "--session-id",
        sessionId,
      ],
      {
        [RUN_ENV.runToken]: run.runToken,
        CLAUDE_CODE_FORK_SUBAGENT: "0",
        MCP_TOOL_TIMEOUT: "600000",
      },
    );
    const row = new RunRepository(db).get(run.id);
    if (!row) throw new Error("the Run disappeared");
    // A model may ask instead of continuing: let the failure say so, not an opaque assertion.
    const now = taskPosition();
    if (now?.subState === "waiting_human") {
      throw new Error(`phase ${phase} was left waiting for the human (ask_human):\n${output}`);
    }
    return { run: row, output };
  }

  function validHandoff(raw: unknown, output: string): Handoff {
    const parsed = parseHandoff(raw);
    expect(parsed.success ? [] : parsed.errors, output).toEqual([]);
    if (!parsed.success) throw new Error("invalid handoff");
    return parsed.data;
  }

  const taskPosition = () => {
    const task = new TaskRepository(db).get(taskId);
    return task && { state: task.state, subState: task.subState };
  };

  it("refine-task sends a spec with submit_spec and leaves the task in refined", async () => {
    const head = git("rev-parse", "HEAD");
    const { run, output } = await dispatch("refine", { state: "draft", subState: "running" });
    expect(run.result, output).toBe("success");
    expect(run.endedAt).toBeInstanceOf(Date);
    const handoff = validHandoff(run.handoff, output);
    expect(handoff).toMatchObject({ phase: "refinement", taskId, runId: run.id });
    expect(taskPosition()).toEqual({ state: "refined", subState: null });
    expect(git("status", "--porcelain"), "the refiner does not write code").toBe("");
    expect(git("rev-parse", "HEAD"), "the refiner does not commit").toBe(head);

    const approved = new SpecRepository(db).approve(taskId, 1);
    expect(approved.ok).toBe(true);
  });

  it("implement-task delivers green commits with submit_for_verification", async () => {
    const { run, output } = await dispatch("implement", {
      state: "in_progress",
      subState: "running",
    });
    expect(run.result, output).toBe("success");
    const handoff = validHandoff(run.handoff, output);
    expect(handoff).toMatchObject({ phase: "implementation", taskId, runId: run.id });
    expect(taskPosition()).toEqual({ state: "verification", subState: "queued" });
    expect(git("status", "--porcelain")).toBe("");
    if (handoff.phase !== "implementation") throw new Error("unexpected phase");
    const branchCommits = git("rev-list", `origin/main..${BRANCH}`).split("\n");
    expect(branchCommits.length).toBeGreaterThan(0);
    for (const sha of handoff.body.commits) {
      expect(
        branchCommits.some((c) => c.startsWith(sha)),
        sha,
      ).toBe(true);
    }
    // The checklist was marked with update_checklist.
    const checklist = latestChecklist(db, taskId);
    expect(checklist?.length, output).toBeGreaterThan(0);
    expect(
      checklist?.every((item) => item.done),
      output,
    ).toBe(true);
    expect(() => execFileSync("node", ["--test"], { cwd: repo, stdio: "ignore" })).not.toThrow();
  });

  it("verify-task issues a verdict with submit_verdict, with the reviewers it says it launched", async () => {
    const head = git("rev-parse", "HEAD");
    const { run, output } = await dispatch("verify", {
      state: "verification",
      subState: "running",
    });
    const handoff = validHandoff(run.handoff, output);
    expect(handoff).toMatchObject({ phase: "verification", taskId, runId: run.id });
    if (handoff.phase !== "verification") throw new Error("unexpected phase");

    // What verification requires: every reviewer reported as ran appears in the Run hooks.
    const recorded = new RunSubagentRepository(db).forRun(run.id).map((r) => r.agentType);
    const ran = Object.entries(handoff.body.reviewers)
      .filter(([, report]) => report.status === "ran")
      .map(([name]) => name);
    expect(ran.length, output).toBeGreaterThan(0);
    for (const name of ran) expect(recorded, name).toContain(name);

    // The verifier does not edit: the revert check is left undone.
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(head);
    if (handoff.body.verdict === "pass") {
      // The Run stays open for delivery (ADR 0007).
      expect(run.endedAt).toBeNull();
      expect(taskPosition()).toEqual({ state: "verification", subState: "running" });
    } else {
      expect(run.result).toBe("success");
      expect(taskPosition()).toEqual({ state: "in_progress", subState: "queued" });
    }
  });
});
