// Arnés de los tests de la entrega: una tarea con el pass del verificador guardado, un checkout
// falso con commits propios y la base ya adelantada, y todos los puertos en memoria.
import { FakeGit, FakeGitHub } from "@lunasq/adapters";
import {
  appendEvent,
  closeRun,
  type LunasqDatabase,
  RunRepository,
  SpecRepository,
  TaskRepository,
} from "@lunasq/db";
import {
  insertProject,
  insertRun,
  insertTask,
  migratedDatabase,
  setTaskPosition,
} from "@lunasq/db/test-helpers";
import { VERDICT_RECORDED } from "@lunasq/schemas";
import { specContentExample } from "@lunasq/schemas/testing";
import { FakePhaseHooks, FakeTestGate, handoffFor } from "../mcp/test-helpers.ts";
import { DeliveryService, type DeliveryServiceDeps } from "./service.ts";

export const WORKTREE = "/wt/tarea";
export const BRANCH = "lunasq/tarea";

export interface DeliveryHarnessOptions {
  /** Posición de la tarea; por defecto verification/running. */
  position?: {
    state: "verification" | "in_progress" | "completed";
    subState: "running" | "queued" | null;
  };
  testCommand?: string | null;
  /** El veredicto guardado; por defecto pass. */
  verdict?: "verification-pass" | "verification-reject";
  /** El Run del verificador ya está cerrado (la entrega se retoma tras una caída). */
  verifierClosed?: boolean;
  without?: { evidence?: true };
}

/** Registra en `calls` cada llamada a `methods` de `target`, sin cambiar lo que hacen. */
function trace<T extends object>(calls: string[], target: T, methods: string[], prefix?: string) {
  for (const name of methods) {
    const original = (target as Record<string, (...a: unknown[]) => unknown>)[name]?.bind(target);
    if (!original) throw new Error(`no existe ${name}`);
    (target as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls.push(prefix ?? name);
      return original(...args);
    };
  }
}

export function deliveryHarness(options: DeliveryHarnessOptions = {}) {
  const db: LunasqDatabase = migratedDatabase();
  const project = insertProject(db, {
    baseBranch: "main",
    testCommand: options.testCommand === undefined ? "pnpm test" : options.testCommand,
  });
  const task = insertTask(db, project.id, {
    intent: "Permitir cancelar pedidos pendientes\n\ny rechazar los enviados",
    state: "draft",
    subState: "running",
    worktreePath: WORKTREE,
    branch: BRANCH,
  });
  const specs = new SpecRepository(db);
  const submitted = specs.submit(task.id, specContentExample());
  if (!submitted.ok) throw new Error(submitted.error.message);
  const approved = specs.approve(task.id, submitted.spec.version);
  if (!approved.ok) throw new Error(approved.error.message);
  setTaskPosition(db, task.id, options.position ?? { state: "verification", subState: "running" });

  const implement = insertRun(db, task.id, {
    phase: "implement",
    startedAt: new Date("2026-01-01T10:00:00Z"),
  });
  closeRun(db, implement.id, {
    result: "success",
    handoff: handoffFor("implementation", implement),
  });
  const verify = insertRun(db, task.id, {
    phase: "verify",
    startedAt: new Date("2026-01-01T11:00:00Z"),
  });
  const verdict = options.verdict ?? "verification-pass";
  const handoff = handoffFor(verdict, verify);
  new RunRepository(db).recordHandoff(verify.id, handoff);
  if (options.verifierClosed) closeRun(db, verify.id, { result: "success" });
  appendEvent(
    db,
    {
      taskId: task.id,
      type: VERDICT_RECORDED,
      actor: "agent",
      payload: {
        runId: verify.id,
        verdict: verdict === "verification-pass" ? "pass" : "reject",
        iteration: 0,
        riskLabel: "low",
        mustFix: 0,
        refuted: 0,
        skippedReviewers: [],
      },
    },
    { publish: true },
  );

  // Checkout con la rama de la tarea dos commits por delante de origin/main.
  const git = new FakeGit();
  git.addCheckout(WORKTREE, { branch: "main", tree: { "README.md": { content: "repo\n" } } });
  const github = new FakeGitHub();
  const testGate = new FakeTestGate();
  const hooks = new FakePhaseHooks();
  const calls: string[] = [];
  trace(calls, git, ["rebase", "addTrailers", "push"]);
  trace(calls, github, ["createPr", "addLabels"]);
  trace(calls, testGate, ["run"], "gate");
  hooks.onRun = (input) => calls.push(`hook:${input.point}`);
  const evidenceCommits: string[] = [];
  const closedRuns: string[] = [];

  const deps: DeliveryServiceDeps = {
    db,
    git,
    github,
    hooks,
    testGate,
    worktrees: {
      ensure: async () => ({
        path: WORKTREE,
        branch: BRANCH,
        workspaceId: "w",
        rootPaneId: "p",
        created: false,
      }),
    },
    runs: {
      closeRun: async (runId, input) => {
        calls.push("close_run");
        closedRuns.push(runId);
        return new RunRepository(db).close(runId, input);
      },
    },
    ...(options.without?.evidence
      ? {}
      : {
          evidence: {
            commit: async (taskId: string) => {
              calls.push("evidence");
              evidenceCommits.push(taskId);
              return null;
            },
          },
        }),
  };
  const service = new DeliveryService(deps);

  /** Dos commits del agente sobre la base, en el checkout falso. */
  async function agentCommits() {
    git.writeWorkingFile(WORKTREE, "src/a.ts");
    await git.commitAll({ cwd: WORKTREE, message: "feat: a", trailers: {} });
    git.writeWorkingFile(WORKTREE, "src/b.ts");
    await git.commitAll({ cwd: WORKTREE, message: "feat: b", trailers: {} });
  }

  /** La base avanza en el remoto con `tree` (que el rebase verá tras el fetch). */
  function baseMoves(tree: Record<string, { content: string }>) {
    git.pushToRemote(WORKTREE, "main", { "README.md": { content: "repo\n" }, ...tree });
  }

  return {
    db,
    project,
    task,
    implement,
    verify,
    handoff,
    git,
    github,
    testGate,
    hooks,
    service,
    deps,
    calls,
    evidenceCommits,
    closedRuns,
    agentCommits,
    baseMoves,
    taskNow: () => new TaskRepository(db).get(task.id),
  };
}
