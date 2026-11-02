// Task repository and dependency DAG (ADR 0010). Writes run in
// IMMEDIATE transactions and leave their event in the Event log; state only changes with
// transitionTask (ADR 0007). Implements the DAG read port for the scheduler.
import {
  DependencyGraph,
  type DependencyGraphReader,
  isTerminal,
  subStateFor,
} from "@lunasq/domain";
import {
  type DependencyLink,
  type ResultKind,
  type StatePosition,
  TASK_CREATED,
  TASK_DEPENDENCY_ADDED,
  TASK_DEPENDENCY_REMOVED,
  TASK_TITLED,
  TASK_UPDATED,
  Task,
  TaskCreate,
  type TaskCreatedPayload,
  type TaskDependencies,
  type TaskDependencyPayload,
  type TaskListQuery,
  TaskTitle,
  type TaskTitledPayload,
  TaskUpdate,
  type TaskUpdatedPayload,
} from "@lunasq/schemas";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { projects, taskDependencies, tasks } from "./schema.ts";
import { applyTransition, type TransitionTaskResult, transitionTask } from "./task-transitions.ts";

export type TaskRepositoryErrorCode =
  | "project_not_found"
  | "dependency_not_found"
  | "caused_by_not_found"
  | "dependency_cancelled"
  | "cycle"
  | "task_not_draft"
  | "task_terminal"
  | "invalid_row";

export class TaskRepositoryError extends Error {
  readonly code: TaskRepositoryErrorCode;
  /** With code `cycle`: the path the edge would close, from the dependent to itself. */
  readonly cycle: string[] | undefined;

  constructor(
    code: TaskRepositoryErrorCode,
    message: string,
    cycle?: string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.cycle = cycle;
    this.name = "TaskRepositoryError";
  }
}

type Row = typeof tasks.$inferSelect;
type Tx = Parameters<Parameters<LunasqDatabase["transaction"]>[0]>[0];
type Reader = Pick<LunasqDatabase, "select">;

export type TaskListFilter = TaskListQuery;

function toTask(row: Row): Task {
  const result = Task.safeParse(row);
  if (!result.success) {
    throw new TaskRepositoryError("invalid_row", `invalid task in ${row.id}`, undefined, {
      cause: result.error,
    });
  }
  return result.data;
}

function findRow(db: Reader, taskId: string): Row | undefined {
  return db.select().from(tasks).where(eq(tasks.id, taskId)).get();
}

const EDITABLE = ["intent", "tags", "priority"] as const;

export class TaskRepository implements DependencyGraphReader {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  /** Validates `input` (throws ZodError if it does not comply) and creates the task in draft with its edges. */
  create(input: TaskCreate): Task {
    const { dependsOn, causedBy, ...values } = TaskCreate.parse(input);
    return this.#write((tx) => {
      const project = tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, values.projectId))
        .get();
      if (!project)
        throw new TaskRepositoryError("project_not_found", "the project does not exist");
      if (causedBy && !findRow(tx, causedBy)) {
        throw new TaskRepositoryError("caused_by_not_found", `task ${causedBy} does not exist`);
      }
      const found =
        dependsOn.length === 0
          ? []
          : tx
              .select({ id: tasks.id, state: tasks.state, projectId: tasks.projectId })
              .from(tasks)
              .where(inArray(tasks.id, dependsOn))
              .all();
      const links = dependsOn.map((dependsOnId) => {
        const target = found.find((t) => t.id === dependsOnId);
        if (!target) {
          throw new TaskRepositoryError(
            "dependency_not_found",
            `task ${dependsOnId} does not exist`,
          );
        }
        if (target.state === "cancelled") {
          throw new TaskRepositoryError("dependency_cancelled", `task ${dependsOnId} is canceled`);
        }
        return { dependsOnId, crossProject: target.projectId !== values.projectId };
      });

      const row = tx
        .insert(tasks)
        .values({
          ...values,
          number: nextTaskNumber(tx),
          causedBy,
          state: "draft",
          subState: subStateFor("draft"),
        })
        .returning()
        .get();
      // A new task has no dependents: its edges cannot close a cycle.
      if (dependsOn.length > 0) {
        tx.insert(taskDependencies)
          .values(dependsOn.map((dependsOnId) => ({ taskId: row.id, dependsOnId })))
          .run();
      }
      const payload: TaskCreatedPayload = {
        number: row.number ?? undefined,
        projectId: row.projectId,
        intent: row.intent,
        tags: row.tags,
        priority: row.priority,
        causedBy: row.causedBy,
        dependsOn: links,
      };
      appendEvent(tx, { taskId: row.id, type: TASK_CREATED, actor: "human", payload });
      return toTask(row);
    });
  }

  get(taskId: string): Task | null {
    const row = findRow(this.db, taskId);
    return row ? toTask(row) : null;
  }

  /** Highest priority first; ties by age. */
  list(filter: TaskListFilter = {}): Task[] {
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          filter.projectId ? eq(tasks.projectId, filter.projectId) : undefined,
          filter.state ? eq(tasks.state, filter.state) : undefined,
        ),
      )
      .orderBy(desc(tasks.priority), asc(tasks.createdAt), asc(sql`rowid`))
      .all()
      .map(toTask);
  }

  /** Replaces the present fields and records task.updated with those that changed. */
  update(taskId: string, patch: TaskUpdate): Task | null {
    const values = TaskUpdate.parse(patch);
    return this.#write((tx) => {
      const current = findRow(tx, taskId);
      if (!current) return null;
      assertNotTerminal(current);
      const from: Record<string, unknown> = {};
      const to: Record<string, unknown> = {};
      for (const field of EDITABLE) {
        const next = values[field];
        if (next === undefined || JSON.stringify(next) === JSON.stringify(current[field])) continue;
        from[field] = current[field];
        to[field] = next;
      }
      if (Object.keys(to).length === 0) return toTask(current);
      const [row] = tx.update(tasks).set(to).where(eq(tasks.id, taskId)).returning().all();
      if (!row) throw new Error("task update without a row");
      const payload = { from, to } as TaskUpdatedPayload;
      appendEvent(tx, { taskId, type: TASK_UPDATED, actor: "human", payload });
      return toTask(row);
    });
  }

  /** Cancels with the state machine; stopping the live agent is up to the dispatcher. */
  cancel(taskId: string, note?: string): TransitionTaskResult {
    return transitionTask(this.db, {
      taskId,
      actor: "human",
      command: note === undefined ? { type: "cancel" } : { type: "cancel", note },
    });
  }

  /**
   * Pauses with the state machine; stopping the live agent is up to the dispatcher.
   * `deliveryInProgress`: the verifier's Run stays open with the handoff saved.
   */
  pause(taskId: string, deliveryInProgress: boolean): TransitionTaskResult {
    return transitionTask(this.db, {
      taskId,
      actor: "human",
      command: { type: "pause", deliveryInProgress },
    });
  }

  /** Resumes a task in needs_human or paused to the state from which it was escalated or paused. */
  resume(taskId: string): TransitionTaskResult {
    return transitionTask(this.db, { taskId, actor: "human", command: { type: "resume" } });
  }

  /**
   * `taskId` starts depending on `dependsOnId`. Idempotent: if the edge already exists it returns
   * `created: false` without writing. null if `taskId` does not exist.
   */
  addDependency(taskId: string, dependsOnId: string): { created: boolean } | null {
    return this.#write((tx) => {
      const task = findRow(tx, taskId);
      if (!task) return null;
      if (edgeExists(tx, taskId, dependsOnId)) return { created: false };
      // Dependencies are validated before refining (docs/design.md §State machine).
      if (task.state !== "draft") {
        throw new TaskRepositoryError(
          "task_not_draft",
          `task ${taskId} is in ${task.state}; dependencies are only added in draft`,
        );
      }
      const target = findRow(tx, dependsOnId);
      if (!target) {
        throw new TaskRepositoryError("dependency_not_found", `task ${dependsOnId} does not exist`);
      }
      if (target.state === "cancelled") {
        throw new TaskRepositoryError("dependency_cancelled", `task ${dependsOnId} is canceled`);
      }
      const cycle = loadGraph(tx).findCycle({ taskId, dependsOnId });
      if (cycle) {
        throw new TaskRepositoryError(
          "cycle",
          `the edge closes a cycle: ${cycle.join(" → ")}`,
          cycle,
        );
      }
      tx.insert(taskDependencies).values({ taskId, dependsOnId }).run();
      const payload: TaskDependencyPayload = {
        dependsOnId,
        crossProject: task.projectId !== target.projectId,
      };
      appendEvent(tx, { taskId, type: TASK_DEPENDENCY_ADDED, actor: "human", payload });
      return { created: true };
    });
  }

  /** Removes the edge if it exists. null if `taskId` does not exist. */
  removeDependency(taskId: string, dependsOnId: string): { removed: boolean } | null {
    return this.#write((tx) => {
      const task = findRow(tx, taskId);
      if (!task) return null;
      assertNotTerminal(task);
      const removed = tx
        .delete(taskDependencies)
        .where(
          and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)),
        )
        .run().changes;
      if (removed === 0) return { removed: false };
      const target = findRow(tx, dependsOnId);
      const payload: TaskDependencyPayload = {
        dependsOnId,
        crossProject: task.projectId !== target?.projectId,
      };
      appendEvent(tx, { taskId, type: TASK_DEPENDENCY_REMOVED, actor: "human", payload });
      return { removed: true };
    });
  }

  /** Direct dependencies and dependents of a task. null if it does not exist. */
  dependencies(taskId: string): TaskDependencies | null {
    // A single transaction: the three reads see the same state.
    return this.db.transaction((tx) => this.#dependencies(tx, taskId));
  }

  #dependencies(db: Reader, taskId: string): TaskDependencies | null {
    const task = findRow(db, taskId);
    if (!task) return null;
    const link = (
      other: Pick<Row, "id" | "number" | "projectId" | "intent" | "title" | "state" | "prState">,
      createdAt: Date,
    ): DependencyLink => ({
      taskId: other.id,
      number: requireTaskNumber(other.number),
      projectId: other.projectId,
      intent: other.intent,
      title: other.title,
      state: other.state,
      prState: other.prState,
      crossProject: other.projectId !== task.projectId,
      createdAt,
    });
    const columns = {
      id: tasks.id,
      number: tasks.number,
      projectId: tasks.projectId,
      intent: tasks.intent,
      title: tasks.title,
      state: tasks.state,
      prState: tasks.prState,
      createdAt: taskDependencies.createdAt,
    };
    const edgeOrder = asc(sql`${taskDependencies}.rowid`);
    const dependsOn = db
      .select(columns)
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId))
      .where(eq(taskDependencies.taskId, taskId))
      .orderBy(edgeOrder)
      .all();
    const dependents = db
      .select(columns)
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(eq(taskDependencies.dependsOnId, taskId))
      .orderBy(edgeOrder)
      .all();
    return {
      dependsOn: dependsOn.map((row) => link(row, row.createdAt)),
      dependents: dependents.map((row) => link(row, row.createdAt)),
    };
  }

  /** Full DAG, including edges between projects. */
  snapshot(): DependencyGraph {
    return loadGraph(this.db);
  }

  // IMMEDIATE takes the write lock before reading: two edges that together would close a
  // cycle cannot be validated at the same time.
  #write<T>(fn: (tx: Tx) => T): T {
    return this.db.transaction(fn, { behavior: "immediate" });
  }
}

/**
 * Sets the task's title if it does not have one yet, inside the caller's transaction. Later
 * refinements do not change it. Returns whether it wrote it.
 */
export function applyTaskTitle(tx: Tx, taskId: string, title: string): boolean {
  const parsed = TaskTitle.parse(title);
  const [row] = tx
    .update(tasks)
    .set({ title: parsed })
    .where(and(eq(tasks.id, taskId), sql`${tasks.title} is null`))
    .returning({ id: tasks.id })
    .all();
  if (!row) return false;
  const payload: TaskTitledPayload = { title: parsed };
  appendEvent(tx, { taskId, type: TASK_TITLED, actor: "agent", payload });
  return true;
}

export type CompleteWithResultInput = {
  taskId: string;
  resultKind: ResultKind;
  result: string;
  /** Handoff title: only set if the task does not have one yet (first refinement). */
  title: string;
  /** Position the caller saw; if it already changed, it is rejected with stale_state. */
  expected?: StatePosition;
};

/**
 * Completes the task with a Result instead of a PR (submit_result, ADR 0007), inside the
 * caller's IMMEDIATE transaction: it applies the command, saves the type and text and sets the
 * title if missing. A state machine rejection writes nothing.
 */
export function completeTaskWithResult(
  tx: Tx,
  input: CompleteWithResultInput,
): TransitionTaskResult {
  const moved = applyTransition(tx, {
    taskId: input.taskId,
    actor: "agent",
    command: { type: "submit_result", resultKind: input.resultKind },
    ...(input.expected && { expected: input.expected }),
  });
  if (!moved.ok) return moved;
  const [task] = tx
    .update(tasks)
    .set({ resultKind: input.resultKind, result: input.result })
    .where(eq(tasks.id, input.taskId))
    .returning()
    .all();
  if (!task) throw new Error(`task ${input.taskId} disappeared when saving its Result`);
  applyTaskTitle(tx, input.taskId, input.title);
  return { ...moved, task: findRow(tx, input.taskId) ?? task };
}

/**
 * The column allows NULL only so the tasks_assign_number trigger can complete the inserts that do not
 * bring it; a row that is read always has it.
 */
export function requireTaskNumber(value: number | null): number {
  if (value === null) throw new TaskRepositoryError("invalid_row", "task without a number");
  return value;
}

/**
 * Next task number (#N). Inside create's IMMEDIATE transaction, so two
 * creations do not read the same maximum; the unique index rejects any repeated one (ADR 0015).
 */
function nextTaskNumber(db: Reader): number {
  const row = db
    .select({ last: sql<number>`coalesce(max(${tasks.number}), 0)` })
    .from(tasks)
    .get();
  return (row?.last ?? 0) + 1;
}

function assertNotTerminal(task: Row): void {
  if (isTerminal(task.state)) {
    throw new TaskRepositoryError("task_terminal", `task ${task.id} is in ${task.state}`);
  }
}

function edgeExists(db: Reader, taskId: string, dependsOnId: string): boolean {
  return (
    db
      .select({ taskId: taskDependencies.taskId })
      .from(taskDependencies)
      .where(
        and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)),
      )
      .get() !== undefined
  );
}

function loadGraph(db: Reader): DependencyGraph {
  const edges = db
    .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
    .from(taskDependencies)
    .orderBy(asc(sql`rowid`))
    .all();
  return DependencyGraph.from(edges);
}
