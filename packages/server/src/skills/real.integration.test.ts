// Las skills de fase contra Claude Code real (criterio de UW-18): cada una produce un handoff
// válido en una tarea de prueba. No corre en `pnpm test`:
//   pnpm --filter @lunasq/server test:skills
// Una sola tarea recorre refinamiento, implementación y verificación sobre un repo temporal. Cada
// fase abre `claude -p` con el prompt de fase del dispatcher, el MCP de LunasQ por `--mcp-config`
// (sin engram: `--strict-mcp-config`), el settings de hooks y el run token en el entorno, como en
// un pane. El gate de tests es el de UW-11 con un runner local en lugar del pane de herdr. Las
// fases corren con `LUNASQ_SKILL_MODEL` (sonnet por defecto) y los revisores con
// `LUNASQ_REVIEWER_MODEL` (haiku por defecto).
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
const BRANCH = "lunasq/prueba";

const INTENT =
  "Agregar a la calculadora la operación dividir(a, b) en src/dividir.js: devuelve a / b y " +
  "rechaza dividir entre cero con un error que lo diga.";

describe.skipIf(!enabled)("skills de fase contra Claude Code real", { timeout: 1_800_000 }, () => {
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
    writeFileSync(join(repo, "package.json"), '{ "name": "calculadora", "type": "module" }\n');
    writeFileSync(join(repo, "src", "sumar.js"), "export const sumar = (a, b) => a + b;\n");
    writeFileSync(
      join(repo, "src", "sumar.test.js"),
      [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { sumar } from "./sumar.js";',
        "",
        'test("sumar dos números devuelve su suma", () => {',
        "  assert.equal(sumar(2, 3), 5);",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, "AGENTS.md"),
      "# Calculadora\n\nJavaScript sin dependencias. Un archivo por operación en `src/`, con su test al lado (`node:test`). Tests: `node --test`.\n",
    );
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "calculadora");
    // Como un worktree de LunasQ: el branch sale de origin/main (ADR 0012).
    execFileSync("git", ["init", "-q", "--bare", join(dir, "origin.git")]);
    git("remote", "add", "origin", join(dir, "origin.git"));
    git("push", "-q", "origin", "main");
    git("fetch", "-q", "origin");
    git("checkout", "-q", "-b", BRANCH, "origin/main");
    git("config", "user.name", "LunasQ prueba");
    git("config", "user.email", "prueba@lunasq.local");
    // Lo que instala `lunasq install` vive fuera del árbol de la tarea: no ensucia el worktree.
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

    // Abierta a mano: las de test-helpers se cierran en cada afterEach y aquí las fases la comparten.
    db = openDatabase(join(dir, "lunasq.db"));
    migrateDatabase(db);
    const project = insertProject(db, { localPath: repo, testCommand: "node --test" });
    taskId = insertTask(db, project.id, {
      intent: INTENT,
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

  /** Despacha la fase como el dispatcher (Run con session id nativo, prompt de fase) y espera. */
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
    if (!row) throw new Error("el Run desapareció");
    // Un modelo puede preguntar en vez de seguir: que el fallo lo diga, no una aserción opaca.
    const now = taskPosition();
    if (now?.subState === "waiting_human") {
      throw new Error(`la fase ${phase} se quedó esperando al humano (ask_human):\n${output}`);
    }
    return { run: row, output };
  }

  function validHandoff(raw: unknown, output: string): Handoff {
    const parsed = parseHandoff(raw);
    expect(parsed.success ? [] : parsed.errors, output).toEqual([]);
    if (!parsed.success) throw new Error("handoff inválido");
    return parsed.data;
  }

  const taskPosition = () => {
    const task = new TaskRepository(db).get(taskId);
    return task && { state: task.state, subState: task.subState };
  };

  it("refine-task envía una spec con submit_spec y deja la tarea en refined", async () => {
    const head = git("rev-parse", "HEAD");
    const { run, output } = await dispatch("refine", { state: "draft", subState: "running" });
    expect(run.result, output).toBe("success");
    expect(run.endedAt).toBeInstanceOf(Date);
    const handoff = validHandoff(run.handoff, output);
    expect(handoff).toMatchObject({ phase: "refinement", taskId, runId: run.id });
    expect(taskPosition()).toEqual({ state: "refined", subState: null });
    expect(git("status", "--porcelain"), "el refinador no escribe código").toBe("");
    expect(git("rev-parse", "HEAD"), "el refinador no commitea").toBe(head);

    const approved = new SpecRepository(db).approve(taskId, 1);
    expect(approved.ok).toBe(true);
  });

  it("implement-task entrega commits en verde con submit_for_verification", async () => {
    const { run, output } = await dispatch("implement", {
      state: "in_progress",
      subState: "running",
    });
    expect(run.result, output).toBe("success");
    const handoff = validHandoff(run.handoff, output);
    expect(handoff).toMatchObject({ phase: "implementation", taskId, runId: run.id });
    expect(taskPosition()).toEqual({ state: "verification", subState: "queued" });
    expect(git("status", "--porcelain")).toBe("");
    if (handoff.phase !== "implementation") throw new Error("fase inesperada");
    const branchCommits = git("rev-list", `origin/main..${BRANCH}`).split("\n");
    expect(branchCommits.length).toBeGreaterThan(0);
    for (const sha of handoff.body.commits) {
      expect(
        branchCommits.some((c) => c.startsWith(sha)),
        sha,
      ).toBe(true);
    }
    // El checklist quedó marcado con update_checklist.
    const checklist = latestChecklist(db, taskId);
    expect(checklist?.length, output).toBeGreaterThan(0);
    expect(
      checklist?.every((item) => item.done),
      output,
    ).toBe(true);
    expect(() => execFileSync("node", ["--test"], { cwd: repo, stdio: "ignore" })).not.toThrow();
  });

  it("verify-task emite un veredicto con submit_verdict, con los revisores que dice haber lanzado", async () => {
    const head = git("rev-parse", "HEAD");
    const { run, output } = await dispatch("verify", {
      state: "verification",
      subState: "running",
    });
    const handoff = validHandoff(run.handoff, output);
    expect(handoff).toMatchObject({ phase: "verification", taskId, runId: run.id });
    if (handoff.phase !== "verification") throw new Error("fase inesperada");

    // Lo que UW-23 exigirá: cada revisor reportado como ran aparece en los hooks del Run.
    const recorded = new RunSubagentRepository(db).forRun(run.id).map((r) => r.agentType);
    const ran = Object.entries(handoff.body.reviewers)
      .filter(([, report]) => report.status === "ran")
      .map(([name]) => name);
    expect(ran.length, output).toBeGreaterThan(0);
    for (const name of ran) expect(recorded, name).toContain(name);

    // El verificador no edita: la prueba de reversión queda deshecha.
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(head);
    if (handoff.body.verdict === "pass") {
      // El Run sigue abierto para la entrega (ADR 0007).
      expect(run.endedAt).toBeNull();
      expect(taskPosition()).toEqual({ state: "verification", subState: "running" });
    } else {
      expect(run.result).toBe("success");
      expect(taskPosition()).toEqual({ state: "in_progress", subState: "queued" });
    }
  });
});
