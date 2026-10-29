// HookService con git y procesos reales: repo remoto bare, checkout del proyecto y worktree de la
// tarea en su branch. Prueba el criterio de UW-10 sin fakes en lo que decide qué se ejecuta.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeHerdr, RealGit, ShellProcessRunner } from "@lunasq/adapters";
import { ProjectRepository, TaskWorktreeRepository } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { taskBranch } from "@lunasq/domain";
import { afterEach, describe, expect, it } from "vitest";
import { HookService } from "./service.ts";

const IDENTITY = ["-c", "user.name=LunasQ Test", "-c", "user.email=test@lunasq.local"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, stdio: "pipe" }).toString("utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, content: string, executable = false) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  chmodSync(full, executable ? 0o755 : 0o644);
}

/** Cada hook agrega una línea a order.log del worktree: deja cambios que LunasQ commitea. */
const appender = (label: string) => `#!/bin/sh\necho ${label} >> "$LUNASQ_WORKTREE/order.log"\n`;

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-hooks-git-")));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  write(seed, "README.md", "repo\n");
  write(seed, "lunasq/hooks/before_delivery/20-second", appender("second"), true);
  write(seed, "lunasq/hooks/before_delivery/10-first", appender("first"), true);
  write(
    seed,
    "lunasq/hooks/config",
    JSON.stringify({ before_delivery: { "20-second": { policy: "warn" } } }),
  );
  git(seed, "add", "--all");
  git(seed, "commit", "--quiet", "-m", "hooks");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "--quiet", "origin", "main");
  execFileSync("git", ["clone", "--quiet", origin, checkout]);

  const db = migratedDatabase();
  const project = insertProject(db, { localPath: checkout });
  const task = insertTask(db, project.id);
  const branch = taskBranch(task.id);
  const wtPath = join(root, "wt");
  git(checkout, "worktree", "add", "--quiet", "-b", branch, wtPath, "origin/main");
  git(wtPath, "config", "user.name", "LunasQ Test");
  git(wtPath, "config", "user.email", "test@lunasq.local");

  const herdr = new FakeHerdr();
  const { workspace, rootPaneId } = await herdr.ensureWorkspace({ cwd: wtPath, label: "wt" });
  const service = new HookService({
    db,
    git: new RealGit(),
    herdr,
    projects: new ProjectRepository(db),
    tasks: new TaskWorktreeRepository(db),
    worktrees: {
      ensure: async () => ({
        branch,
        path: wtPath,
        workspaceId: workspace.workspaceId,
        rootPaneId,
        created: false,
      }),
    },
    runnerFor: () => new ShellProcessRunner(),
    scriptsDir: join(root, "scripts"),
  });
  return { root, seed, wtPath, task, service };
}

describe("HookService con git real", () => {
  it("los hooks corren en orden y lo que dejan se commitea con los trailers", async () => {
    const { wtPath, task, service } = await setup();

    const res = await service.run({ taskId: task.id, point: "before_delivery", runId: "run-1" });

    expect(res.outcome).toBe("passed");
    expect(res.executions.map((e) => e.script)).toEqual(["10-first", "20-second"]);
    expect(readFileSync(join(wtPath, "order.log"), "utf8")).toBe("first\nsecond\n");
    expect(res.commit).toBe(git(wtPath, "rev-parse", "HEAD").trim());
    expect(git(wtPath, "log", "-1", "--format=%B")).toBe(
      `chore(lunasq): hooks before_delivery\n\nLunasQ-Task: ${task.id}\nLunasQ-Run: run-1\n\n`,
    );
    expect(git(wtPath, "status", "--porcelain")).toBe("");
  });

  it("un hook modificado o agregado en el branch de la tarea nunca se ejecuta", async () => {
    const { root, wtPath, task, service } = await setup();
    const pwned = join(root, "pwned");
    const evil = `#!/bin/sh\ntouch ${pwned}\necho evil >> "$LUNASQ_WORKTREE/order.log"\n`;
    // El agente cambia hooks y config en su branch y los commitea...
    write(wtPath, "lunasq/hooks/before_delivery/10-first", evil, true);
    write(wtPath, "lunasq/hooks/before_delivery/05-added", evil, true);
    write(
      wtPath,
      "lunasq/hooks/config",
      JSON.stringify({ before_delivery: { "10-first": { policy: "warn" } } }),
    );
    git(wtPath, "add", "--all");
    git(wtPath, "commit", "--quiet", "-m", "cambio hooks");
    // ...y deja otro cambio sin commit.
    write(wtPath, "lunasq/hooks/before_delivery/20-second", evil, true);

    const res = await service.run({ taskId: task.id, point: "before_delivery" });

    expect(existsSync(pwned)).toBe(false);
    expect(res.executions.map((e) => [e.script, e.policy])).toEqual([
      ["10-first", "block"],
      ["20-second", "warn"],
    ]);
    expect(readFileSync(join(wtPath, "order.log"), "utf8")).toBe("first\nsecond\n");
    // El worktree tenía cambios sin commit antes de los hooks: no se mezclan en un commit.
    expect(res).toMatchObject({ outcome: "warned", commit: null, commitSkipped: true });
  });

  it("un cambio de hook entra en vigor cuando llega a la rama base", async () => {
    const { seed, wtPath, task, service } = await setup();
    write(seed, "lunasq/hooks/before_delivery/10-first", appender("first-v2"), true);
    git(seed, "commit", "--quiet", "-am", "hook v2");
    git(seed, "push", "--quiet", "origin", "main");

    await service.run({ taskId: task.id, point: "before_delivery" });

    expect(readFileSync(join(wtPath, "order.log"), "utf8")).toBe("first-v2\nsecond\n");
  });

  it("after_merge corre en el commit mergeado aunque el checkout del proyecto esté atrasado", async () => {
    const { seed, root, task, service } = await setup();
    const out = join(root, "deployed");
    write(seed, "lunasq/hooks/after_merge/10-deploy", `#!/bin/sh\ncat VERSION > ${out}\n`, true);
    write(seed, "VERSION", "2.0.0\n");
    git(seed, "add", "--all");
    git(seed, "commit", "--quiet", "-m", "merge");
    git(seed, "push", "--quiet", "origin", "main");

    const res = await service.run({ taskId: task.id, point: "after_merge" });

    expect(res.outcome).toBe("passed");
    expect(readFileSync(out, "utf8")).toBe("2.0.0\n");
    expect(git(join(root, "checkout"), "worktree", "list").trim().split("\n")).toHaveLength(2);
  });
});
