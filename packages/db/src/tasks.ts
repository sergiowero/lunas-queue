// Repositorio de tareas y del DAG de dependencias (ADR 0010). Las escrituras corren en
// transacciones IMMEDIATE y dejan su evento en el Event log; el estado solo cambia con
// transitionTask (ADR 0007). Implementa el puerto de lectura del DAG para el scheduler.
import {
  DependencyGraph,
  type DependencyGraphReader,
  isTerminal,
  subStateFor,
} from "@lunasq/domain";
import {
  type DependencyLink,
  TASK_CREATED,
  TASK_DEPENDENCY_ADDED,
  TASK_DEPENDENCY_REMOVED,
  TASK_UPDATED,
  Task,
  TaskCreate,
  type TaskCreatedPayload,
  type TaskDependencies,
  type TaskDependencyPayload,
  type TaskListQuery,
  TaskUpdate,
  type TaskUpdatedPayload,
} from "@lunasq/schemas";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { projects, taskDependencies, tasks } from "./schema.ts";
import { type TransitionTaskResult, transitionTask } from "./task-transitions.ts";

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
  /** Con code `cycle`: el camino que cerraría la arista, de la dependiente a sí misma. */
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
    throw new TaskRepositoryError("invalid_row", `tarea inválida en ${row.id}`, undefined, {
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

  /** Valida `input` (lanza ZodError si no cumple) y crea la tarea en draft con sus aristas. */
  create(input: TaskCreate): Task {
    const { dependsOn, causedBy, ...values } = TaskCreate.parse(input);
    return this.#write((tx) => {
      const project = tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, values.projectId))
        .get();
      if (!project) throw new TaskRepositoryError("project_not_found", "no existe el proyecto");
      if (causedBy && !findRow(tx, causedBy)) {
        throw new TaskRepositoryError("caused_by_not_found", `no existe la tarea ${causedBy}`);
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
            `no existe la tarea ${dependsOnId}`,
          );
        }
        if (target.state === "cancelled") {
          throw new TaskRepositoryError(
            "dependency_cancelled",
            `la tarea ${dependsOnId} está cancelada`,
          );
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
      // Una tarea nueva no tiene dependientes: sus aristas no pueden cerrar un ciclo.
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

  /** Mayor prioridad primero; los empates, por antigüedad. */
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

  /** Reemplaza los campos presentes y registra task.updated con los que cambiaron. */
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
      if (!row) throw new Error("update de task sin fila");
      const payload = { from, to } as TaskUpdatedPayload;
      appendEvent(tx, { taskId, type: TASK_UPDATED, actor: "human", payload });
      return toTask(row);
    });
  }

  /** Cancela con la máquina de estados; detener el agente vivo es del dispatcher (UW-16/17). */
  cancel(taskId: string, note?: string): TransitionTaskResult {
    return transitionTask(this.db, {
      taskId,
      actor: "human",
      command: note === undefined ? { type: "cancel" } : { type: "cancel", note },
    });
  }

  /**
   * `taskId` pasa a depender de `dependsOnId`. Idempotente: si la arista ya existe devuelve
   * `created: false` sin escribir. null si `taskId` no existe.
   */
  addDependency(taskId: string, dependsOnId: string): { created: boolean } | null {
    return this.#write((tx) => {
      const task = findRow(tx, taskId);
      if (!task) return null;
      if (edgeExists(tx, taskId, dependsOnId)) return { created: false };
      // Las dependencias se validan antes de refinar (docs/design.md §Máquina de estados).
      if (task.state !== "draft") {
        throw new TaskRepositoryError(
          "task_not_draft",
          `la tarea ${taskId} está en ${task.state}; solo se agregan dependencias en draft`,
        );
      }
      const target = findRow(tx, dependsOnId);
      if (!target) {
        throw new TaskRepositoryError("dependency_not_found", `no existe la tarea ${dependsOnId}`);
      }
      if (target.state === "cancelled") {
        throw new TaskRepositoryError(
          "dependency_cancelled",
          `la tarea ${dependsOnId} está cancelada`,
        );
      }
      const cycle = loadGraph(tx).findCycle({ taskId, dependsOnId });
      if (cycle) {
        throw new TaskRepositoryError(
          "cycle",
          `la arista cierra un ciclo: ${cycle.join(" → ")}`,
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

  /** Quita la arista si existe. null si `taskId` no existe. */
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

  /** Dependencias y dependientes directos de una tarea. null si no existe. */
  dependencies(taskId: string): TaskDependencies | null {
    // Una sola transacción: las tres lecturas ven el mismo estado.
    return this.db.transaction((tx) => this.#dependencies(tx, taskId));
  }

  #dependencies(db: Reader, taskId: string): TaskDependencies | null {
    const task = findRow(db, taskId);
    if (!task) return null;
    const link = (
      other: Pick<Row, "id" | "number" | "projectId" | "intent" | "state" | "prState">,
      createdAt: Date,
    ): DependencyLink => ({
      taskId: other.id,
      number: other.number as number,
      projectId: other.projectId,
      intent: other.intent,
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

  /** DAG completo, incluidas las aristas entre proyectos. */
  snapshot(): DependencyGraph {
    return loadGraph(this.db);
  }

  // IMMEDIATE toma el lock de escritura antes de leer: dos aristas que juntas cerrarían un
  // ciclo no pueden validarse a la vez.
  #write<T>(fn: (tx: Tx) => T): T {
    return this.db.transaction(fn, { behavior: "immediate" });
  }
}

/**
 * Siguiente número de tarea (#N). Dentro de la transacción IMMEDIATE de create, así dos
 * creaciones no leen el mismo máximo; el índice único rechaza cualquier repetido (ADR 0015).
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
    throw new TaskRepositoryError("task_terminal", `la tarea ${task.id} está en ${task.state}`);
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
