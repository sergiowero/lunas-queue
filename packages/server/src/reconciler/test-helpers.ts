// Arnés de los tests de señales y reconciliación: base migrada, herdr y procesos falsos,
// dispatcher real con el watcher como observador y notificaciones capturadas.
import { FakeHerdr, FakeProcessRunner } from "@lunasq/adapters";
import {
  ProjectRepository,
  ProjectWorkspaceRepository,
  RunRepository,
  type RunRow,
  TaskWorktreeRepository,
} from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import type { DispatchDecision } from "@lunasq/domain";
import type { Notification, ProjectCreate } from "@lunasq/schemas";
import { PhaseDispatcher } from "../dispatcher/dispatcher.ts";
import { Escalator } from "../notifications/escalator.ts";
import { WorktreeService } from "../worktrees/service.ts";
import { RunWatcher, type RunWatcherOptions } from "./watcher.ts";

export const SEC = 1000;
export const MIN = 60 * SEC;

export function harness(
  opts: {
    project?: Partial<ProjectCreate>;
    watcher?: Partial<RunWatcherOptions>;
    herdr?: FakeHerdr;
  } = {},
) {
  const db = migratedDatabase();
  const project = insertProject(db, opts.project);
  // Los prompts no terminan solos (20 días, bajo el tope de setTimeout): cada test decide.
  const herdr = opts.herdr ?? new FakeHerdr({ promptDurationMs: 20 * 24 * 60 * MIN });
  const projects = new ProjectRepository(db);
  const worktrees = new WorktreeService({
    herdr,
    processes: new FakeProcessRunner(),
    projects,
    tasks: new TaskWorktreeRepository(db),
    workspaces: new ProjectWorkspaceRepository(db),
  });
  const notifications: Notification[] = [];
  const errors: { error: Error; runId: string | null }[] = [];
  const notify = (n: Notification) => {
    notifications.push(n);
  };
  const escalator = new Escalator({ notify });
  let lost = 0;
  let dispatcher: PhaseDispatcher | undefined;
  const watcher = new RunWatcher({
    db,
    herdr,
    projects,
    escalator,
    notify,
    failRun: (runId, reason) => {
      if (!dispatcher) throw new Error("sin dispatcher");
      return dispatcher.failRun(runId, reason);
    },
    onLost: () => {
      lost += 1;
    },
    onError: (error, runId) => errors.push({ error, runId }),
    ...opts.watcher,
  });
  let sessions = 0;
  dispatcher = new PhaseDispatcher({
    db,
    herdr,
    worktrees,
    projects,
    mcpConfigPath: "/cfg/lunasq-mcp.json",
    observer: watcher,
    newSessionId: () => `sess-${++sessions}`,
    onError: (error, runId) => errors.push({ error, runId }),
  });
  const runs = new RunRepository(db);
  const taskRow = (id: string) =>
    db.$client
      .prepare(
        "select state, sub_state as subState, worktree_path as worktreePath from tasks where id = ?",
      )
      .get(id) as { state: string; subState: string | null; worktreePath: string | null };

  /** Crea una tarea en draft/queued y despacha su refinamiento hasta mandar el prompt. */
  async function launched(): Promise<{ taskId: string; run: RunRow; name: string }> {
    const task = insertTask(db, project.id);
    const decision: DispatchDecision = {
      taskId: task.id,
      projectId: project.id,
      phase: "refine",
      agentKind: "claude",
      score: 0,
      expected: { state: "draft", subState: "queued" },
    };
    await dispatcher?.dispatch(decision);
    await dispatcher?.idle();
    const run = runs.latestForTask(task.id);
    if (!run?.herdrName || !run.launchedAt) throw new Error("el Run no se lanzó");
    return { taskId: task.id, run, name: run.herdrName };
  }

  return {
    db,
    project,
    herdr,
    projects,
    worktrees,
    dispatcher,
    watcher,
    escalator,
    runs,
    notifications,
    errors,
    taskRow,
    launched,
    lost: () => lost,
    stop: async () => {
      await watcher.stop();
      escalator.stop();
      await dispatcher?.idle();
    },
  };
}

/** Deja correr las microtareas y los timers vencidos (eventos del fake, locks). */
export async function settle(vi: { advanceTimersByTimeAsync(ms: number): Promise<unknown> }) {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}
