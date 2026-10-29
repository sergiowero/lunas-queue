import { randomUUID } from "node:crypto";
import { FakeHerdr, FakeProcessRunner, type ProcessInput } from "@lunasq/adapters";
import { ProjectRepository, ProjectWorkspaceRepository, TaskWorktreeRepository } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { taskBranch } from "@lunasq/domain";
import { describe, expect, it, vi } from "vitest";
import { isWorktreeError, WorktreeService } from "./service.ts";

const isFetch = (c: ProcessInput) => c.command.startsWith("git fetch");

function setup(opts: { bootstrap?: string | null } = {}) {
  const db = migratedDatabase();
  const project = insertProject(db, {
    bootstrap: opts.bootstrap === undefined ? "pnpm install" : opts.bootstrap,
  });
  const herdr = new FakeHerdr();
  const processes = new FakeProcessRunner();
  const tasks = new TaskWorktreeRepository(db);
  const service = new WorktreeService({
    herdr,
    processes,
    projects: new ProjectRepository(db),
    tasks,
  });
  const bootstraps = () => processes.calls.filter((c) => !isFetch(c));
  const projectWorkspace = async () =>
    (await herdr.ensureWorkspace({ cwd: project.localPath, label: project.name })).workspace
      .workspaceId;
  return { db, project, herdr, processes, tasks, service, bootstraps, projectWorkspace };
}

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("no lanzó");
    },
    (err: unknown) => err,
  );
}

describe("WorktreeService.ensure", () => {
  it("crea worktree y branch desde la rama base remota, corre el bootstrap y lo guarda", async () => {
    const { db, project, herdr, processes, tasks, service, bootstraps } = setup();
    const task = insertTask(db, project.id);
    const create = vi.spyOn(herdr, "ensureWorktree");

    const res = await service.ensure(task.id);

    expect(res.created).toBe(true);
    expect(res.branch).toBe(taskBranch(task.id));
    expect(processes.calls[0]).toEqual({
      command: "git fetch --quiet origin 'main'",
      cwd: project.localPath,
      timeoutMs: expect.any(Number),
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ branch: res.branch, base: "origin/main" }),
    );
    expect(bootstraps()).toEqual([
      {
        command: "pnpm install",
        cwd: res.path,
        env: {
          LUNASQ_PROJECT_ID: project.id,
          LUNASQ_TASK_ID: task.id,
          LUNASQ_BRANCH: res.branch,
          LUNASQ_BASE_BRANCH: "main",
          LUNASQ_WORKTREE: res.path,
        },
        timeoutMs: expect.any(Number),
      },
    ]);
    expect(tasks.get(task.id)).toMatchObject({ branch: res.branch, worktreePath: res.path });
  });

  it("dos tareas del mismo repo trabajan en paralelo sin compartir branch ni worktree", async () => {
    const { db, project, herdr, tasks, service, bootstraps } = setup();
    const a = insertTask(db, project.id);
    const b = insertTask(db, project.id);

    const [ra, rb] = await Promise.all([service.ensure(a.id), service.ensure(b.id)]);

    expect(ra.branch).not.toBe(rb.branch);
    expect(ra.path).not.toBe(rb.path);
    expect(ra.workspaceId).not.toBe(rb.workspaceId);
    expect(
      bootstraps()
        .map((c) => c.cwd)
        .sort(),
    ).toEqual([ra.path, rb.path].sort());
    expect(tasks.get(a.id)?.worktreePath).toBe(ra.path);
    expect(tasks.get(b.id)?.worktreePath).toBe(rb.path);
    // Un solo workspace de proyecto, con los dos worktrees agrupados.
    const snap = await herdr.snapshot();
    expect(snap.workspaces.filter((w) => !w.linkedWorktree)).toHaveLength(1);
    expect(snap.workspaces.filter((w) => w.linkedWorktree)).toHaveLength(2);
  });

  it("repetir ensure no duplica worktree, workspace ni bootstrap", async () => {
    const { db, project, herdr, service, bootstraps, projectWorkspace } = setup();
    const task = insertTask(db, project.id);

    const first = await service.ensure(task.id);
    const before = (await herdr.snapshot()).workspaces.length;
    const second = await service.ensure(task.id);

    expect(second).toEqual({ ...first, created: false });
    expect((await herdr.snapshot()).workspaces).toHaveLength(before);
    expect(await herdr.listWorktrees(await projectWorkspace())).toHaveLength(1);
    expect(bootstraps()).toHaveLength(1);
  });

  it("dos ensure concurrentes de la misma tarea crean un solo worktree", async () => {
    const { db, project, herdr, service, bootstraps, projectWorkspace } = setup();
    const task = insertTask(db, project.id);

    const results = await Promise.all([service.ensure(task.id), service.ensure(task.id)]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]?.path).toBe(results[1]?.path);
    expect(await herdr.listWorktrees(await projectWorkspace())).toHaveLength(1);
    expect(bootstraps()).toHaveLength(1);
  });

  it("reabre el mismo worktree si su workspace se cerró, sin volver a correr el bootstrap", async () => {
    const { db, project, herdr, processes, service, bootstraps } = setup();
    const task = insertTask(db, project.id);
    const first = await service.ensure(task.id);
    await herdr.closeWorkspace(first.workspaceId);
    const calls = processes.calls.length;

    const again = await service.ensure(task.id);

    expect(again.created).toBe(false);
    expect(again.path).toBe(first.path);
    expect(again.branch).toBe(first.branch);
    expect(again.workspaceId).not.toBe(first.workspaceId);
    expect(processes.calls).toHaveLength(calls);
    expect(bootstraps()).toHaveLength(1);
  });

  it("si el bootstrap falla no guarda el worktree y el siguiente ensure lo reintenta", async () => {
    const { db, project, processes, tasks, service, bootstraps } = setup();
    const task = insertTask(db, project.id);
    processes.respond((c) => (isFetch(c) ? {} : { exitCode: 1, stderr: "ERR_PNPM" }));

    const err = await rejection(service.ensure(task.id));
    expect(isWorktreeError(err, "bootstrap_failed")).toBe(true);
    expect(String(err)).toContain("ERR_PNPM");
    expect(tasks.get(task.id)?.worktreePath).toBeNull();

    processes.respond(() => ({}));
    const res = await service.ensure(task.id);
    expect(res.created).toBe(false);
    expect(bootstraps()).toHaveLength(2);
    expect(tasks.get(task.id)?.worktreePath).toBe(res.path);
  });

  it("si el checkout cambió de ruta y el bootstrap falla, la ruta vieja no queda como lista", async () => {
    const { db, project, herdr, processes, tasks, service } = setup();
    const task = insertTask(db, project.id);
    const first = await service.ensure(task.id);
    // El checkout desaparece por fuera de LunasQ; la BD aún tiene su ruta.
    await herdr.removeWorktree({ workspaceId: first.workspaceId });
    tasks.recordWorktree(task.id, { branch: first.branch, worktreePath: "/ruta/vieja" });
    processes.respond((c) => (isFetch(c) ? {} : { exitCode: 1 }));

    const err = await rejection(service.ensure(task.id));

    expect(isWorktreeError(err, "bootstrap_failed")).toBe(true);
    expect(tasks.get(task.id)?.worktreePath).toBeNull();
  });

  it("un bootstrap que vence su timeout cuenta como fallo", async () => {
    const { db, project, processes, service } = setup();
    const task = insertTask(db, project.id);
    processes.respond((c) => (isFetch(c) ? {} : { exitCode: 137, timedOut: true }));
    const err = await rejection(service.ensure(task.id));
    expect(isWorktreeError(err, "bootstrap_failed")).toBe(true);
  });

  it("sin bootstrap configurado no corre nada en el worktree", async () => {
    const { db, project, tasks, service, bootstraps } = setup({ bootstrap: null });
    const task = insertTask(db, project.id);
    const res = await service.ensure(task.id);
    expect(bootstraps()).toEqual([]);
    expect(tasks.get(task.id)?.worktreePath).toBe(res.path);
  });

  it("si el fetch de la rama base falla no crea nada", async () => {
    const { db, project, herdr, processes, tasks, service, projectWorkspace } = setup();
    const task = insertTask(db, project.id);
    processes.respond(() => ({ exitCode: 128, stderr: "Could not resolve host" }));

    const err = await rejection(service.ensure(task.id));

    expect(isWorktreeError(err, "base_fetch_failed")).toBe(true);
    expect(await herdr.listWorktrees(await projectWorkspace())).toEqual([]);
    expect(tasks.get(task.id)?.branch).toBeNull();
  });

  it("rechaza tareas inexistentes y tareas que ya liberaron su worktree", async () => {
    const { db, project, service } = setup();
    const cancelled = insertTask(db, project.id, { state: "cancelled" });
    const merged = insertTask(db, project.id, { state: "completed", prState: "merged" });
    expect(isWorktreeError(await rejection(service.ensure(randomUUID())), "task_not_found")).toBe(
      true,
    );
    for (const task of [cancelled, merged]) {
      expect(isWorktreeError(await rejection(service.ensure(task.id)), "task_released")).toBe(true);
    }
  });

  it("una tarea completed con el PR abierto conserva y reabre su worktree", async () => {
    const { db, project, service } = setup();
    const task = insertTask(db, project.id);
    const first = await service.ensure(task.id);
    db.$client.prepare("update tasks set state = 'completed', pr_state = 'open'").run();
    expect((await service.ensure(task.id)).path).toBe(first.path);
  });
});

describe("WorktreeService: workspace del proyecto", () => {
  it("guarda el id del workspace y lo reutiliza aunque el proyecto cambie de nombre", async () => {
    const db = migratedDatabase();
    const project = insertProject(db);
    const herdr = new FakeHerdr();
    const workspaces = new ProjectWorkspaceRepository(db);
    const projects = new ProjectRepository(db);
    const service = new WorktreeService({
      herdr,
      processes: new FakeProcessRunner(),
      projects,
      tasks: new TaskWorktreeRepository(db),
      workspaces,
    });
    const a = insertTask(db, project.id);
    await service.ensure(a.id);
    const stored = workspaces.get(project.id);
    expect(stored).not.toBeNull();

    projects.update(project.id, { name: `${project.name}-nuevo` });
    const ensure = vi.spyOn(herdr, "ensureWorkspace");
    await service.ensure(insertTask(db, project.id).id);

    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: stored }));
    const snap = await herdr.snapshot();
    expect(snap.workspaces.filter((w) => !w.linkedWorktree)).toHaveLength(1);
    expect(workspaces.get(project.id)).toBe(stored);
  });

  it("no adopta un id guardado que ahora es de otro proyecto (herdr reutiliza ids)", async () => {
    const db = migratedDatabase();
    const project = insertProject(db);
    const herdr = new FakeHerdr();
    const other = await herdr.ensureWorkspace({ cwd: "/otro/repo", label: "otro" });
    const workspaces = new ProjectWorkspaceRepository(db);
    workspaces.record(project.id, other.workspace.workspaceId);
    const service = new WorktreeService({
      herdr,
      processes: new FakeProcessRunner(),
      projects: new ProjectRepository(db),
      tasks: new TaskWorktreeRepository(db),
      workspaces,
    });

    await service.ensure(insertTask(db, project.id).id);

    expect(workspaces.get(project.id)).not.toBe(other.workspace.workspaceId);
    expect(await herdr.listWorktrees(other.workspace.workspaceId)).toEqual([]);
  });

  it("si el workspace guardado ya no existe, guarda el nuevo", async () => {
    const db = migratedDatabase();
    const project = insertProject(db);
    const herdr = new FakeHerdr();
    const workspaces = new ProjectWorkspaceRepository(db);
    workspaces.record(project.id, "w99");
    const service = new WorktreeService({
      herdr,
      processes: new FakeProcessRunner(),
      projects: new ProjectRepository(db),
      tasks: new TaskWorktreeRepository(db),
      workspaces,
    });
    await service.ensure(insertTask(db, project.id).id);
    expect(workspaces.get(project.id)).not.toBe("w99");
    expect(workspaces.get(project.id)).toMatch(/^w\d+$/);
  });
});

describe("WorktreeService.remove", () => {
  it("borra el checkout, limpia la ruta y conserva el branch; repetirlo no hace nada", async () => {
    const { db, project, herdr, tasks, service, projectWorkspace } = setup();
    const task = insertTask(db, project.id);
    const { branch } = await service.ensure(task.id);

    expect(await service.remove(task.id)).toEqual({ removed: true });
    expect(await herdr.listWorktrees(await projectWorkspace())).toEqual([]);
    expect(tasks.get(task.id)).toMatchObject({ branch, worktreePath: null });

    expect(await service.remove(task.id)).toEqual({ removed: false });
  });

  it("remueve un worktree cuyo workspace estaba cerrado", async () => {
    const { db, project, herdr, service, projectWorkspace } = setup();
    const task = insertTask(db, project.id);
    const { workspaceId } = await service.ensure(task.id);
    await herdr.closeWorkspace(workspaceId);

    expect(await service.remove(task.id)).toEqual({ removed: true });
    expect(await herdr.listWorktrees(await projectWorkspace())).toEqual([]);
  });

  it("con cambios sin commit exige force", async () => {
    const { db, project, herdr, tasks, service } = setup();
    const task = insertTask(db, project.id);
    const { path } = await service.ensure(task.id);
    herdr.setWorktreeDirty(path);

    const err = await rejection(service.remove(task.id));
    expect(isWorktreeError(err, "dirty_worktree")).toBe(true);
    expect(tasks.get(task.id)?.worktreePath).toBe(path);

    expect(await service.remove(task.id, { force: true })).toEqual({ removed: true });
  });

  it("no espera a un ensure de otra tarea, pero sí al de la misma", async () => {
    const { db, project, processes, service } = setup();
    const task = insertTask(db, project.id);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    processes.respond(async (c) => {
      if (!isFetch(c)) await gate;
      return {};
    });
    const ensuring = service.ensure(task.id);
    const removing = service.remove(task.id);
    release();
    await ensuring;
    // remove corrió después del ensure: encontró el worktree y lo borró.
    expect(await removing).toEqual({ removed: true });
  });
});

describe("WorktreeService: huérfanos", () => {
  async function scenario() {
    const s = setup({ bootstrap: null });
    const { db, project, herdr, service, projectWorkspace } = s;
    const active = insertTask(db, project.id);
    const openPr = insertTask(db, project.id);
    const cancelled = insertTask(db, project.id);
    const merged = insertTask(db, project.id);
    for (const t of [active, openPr, cancelled, merged]) await service.ensure(t.id);
    db.$client
      .prepare("update tasks set state = 'completed', pr_state = 'open' where id = ?")
      .run(openPr.id);
    db.$client.prepare("update tasks set state = 'cancelled' where id = ?").run(cancelled.id);
    db.$client
      .prepare("update tasks set state = 'completed', pr_state = 'merged' where id = ?")
      .run(merged.id);
    const workspaceId = await projectWorkspace();
    const gone = randomUUID();
    await herdr.ensureWorktree({ workspaceId, branch: taskBranch(gone), base: "main" });
    await herdr.ensureWorktree({ workspaceId, branch: "feature/ajeno", base: "main" });
    return { ...s, active, openPr, cancelled, merged, gone, workspaceId };
  }

  it("detecta los worktrees sin tarea activa y no toca los ajenos", async () => {
    const { project, service, cancelled, merged, gone } = await scenario();
    const orphans = await service.findOrphans(project.id);
    expect(orphans.map((o) => [o.taskId, o.reason]).sort()).toEqual(
      [
        [cancelled.id, "task_released"],
        [merged.id, "task_released"],
        [gone, "task_not_found"],
      ].sort(),
    );
  });

  it("cleanupOrphans los remueve, limpia la ruta y repetirlo no hace nada", async () => {
    const { project, herdr, tasks, service, active, openPr, cancelled, workspaceId } =
      await scenario();

    const first = await service.cleanupOrphans(project.id);
    expect(first.removed).toHaveLength(3);
    expect(first.failed).toEqual([]);
    const left = (await herdr.listWorktrees(workspaceId)).map((w) => w.branch).sort();
    expect(left).toEqual([taskBranch(active.id), taskBranch(openPr.id), "feature/ajeno"].sort());
    expect(tasks.get(cancelled.id)?.worktreePath).toBeNull();

    expect(await service.cleanupOrphans(project.id)).toEqual({ removed: [], failed: [] });
  });

  it("un huérfano con cambios sin commit se reporta y no se borra", async () => {
    const { project, herdr, service, cancelled, workspaceId } = await scenario();
    const dirty = (await herdr.listWorktrees(workspaceId)).find(
      (w) => w.branch === taskBranch(cancelled.id),
    );
    herdr.setWorktreeDirty(dirty?.path ?? "");

    const res = await service.cleanupOrphans(project.id);

    expect(res.removed).toHaveLength(2);
    expect(res.failed).toEqual([
      {
        taskId: cancelled.id,
        path: dirty?.path,
        code: "dirty_worktree",
        message: expect.any(String),
      },
    ]);
    expect((await herdr.listWorktrees(workspaceId)).map((w) => w.branch)).toContain(
      taskBranch(cancelled.id),
    );
  });

  it("no toma por huérfano el worktree de una tarea activa de otro proyecto del mismo repo", async () => {
    const { db, project, herdr, service, workspaceId } = await scenario();
    const other = insertProject(db);
    const foreign = insertTask(db, other.id);
    await herdr.ensureWorktree({ workspaceId, branch: taskBranch(foreign.id), base: "main" });
    const orphans = await service.findOrphans(project.id);
    expect(orphans.map((o) => o.taskId)).not.toContain(foreign.id);
  });

  it("findOrphans de un proyecto inexistente falla con project_not_found", async () => {
    const { service } = setup();
    const err = await rejection(service.findOrphans(randomUUID()));
    expect(isWorktreeError(err, "project_not_found")).toBe(true);
  });
});
