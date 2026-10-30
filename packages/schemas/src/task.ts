// Task y sus aristas del DAG (docs/design.md §Modelo de dominio y §Scheduler, ADR 0010).
// Estado, sub-estado e iteración no se capturan aquí: solo los mueve la máquina de estados.
import { z } from "zod";
import { PrState, RiskLabel, SubState, TaskState } from "./enums.ts";

const unique = <T>(items: T[]): T[] => [...new Set(items)];

// Entero sin signo hasta MAX_SAFE_INTEGER, como el CHECK de la columna (ADR 0005).
export const Priority = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Título corto que genera el refinador; se muestra en la UI y titula el PR. */
export const TASK_TITLE_MAX = 72;
export const TaskTitle = z.string().trim().min(1).max(TASK_TITLE_MAX);

/** Número de tarea (#N): secuencial global, inmutable y sin reuso; no sustituye al UUID (ADR 0015). */
export const TaskNumber = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

const Intent = z.string().trim().min(1).max(10_000);
const Tags = z.array(z.string().trim().min(1).max(64)).max(32).transform(unique);

export const TaskCreate = z.strictObject({
  projectId: z.uuid(),
  intent: Intent,
  tags: Tags.default(() => []),
  priority: Priority,
  // Tarea que originó este bugfix.
  causedBy: z.uuid().optional(),
  // Aristas iniciales: la nueva tarea depende de estas.
  dependsOn: z
    .array(z.uuid())
    .max(100)
    .transform(unique)
    .default(() => []),
});
export type TaskCreate = z.input<typeof TaskCreate>;

// PATCH: cada campo presente reemplaza al guardado.
export const TaskUpdate = z.strictObject({
  intent: Intent.optional(),
  tags: Tags.optional(),
  priority: Priority.optional(),
});
export type TaskUpdate = z.input<typeof TaskUpdate>;

const Note = z.string().min(1).max(2000);

export const TaskCancel = z.strictObject({ note: Note.optional() });
export type TaskCancel = z.infer<typeof TaskCancel>;

export const Task = z.strictObject({
  id: z.uuid(),
  number: TaskNumber,
  projectId: z.uuid(),
  intent: z.string().min(1),
  // null hasta el primer refinamiento; después no cambia.
  title: TaskTitle.nullable(),
  tags: z.array(z.string()),
  priority: Priority,
  state: TaskState,
  subState: SubState.nullable(),
  verificationIteration: z.int().min(0),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  prUrl: z.string().nullable(),
  prState: PrState.nullable(),
  riskLabel: RiskLabel.nullable(),
  causedBy: z.uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Task = z.infer<typeof Task>;

/** La otra tarea de una arista, vista desde una tarea: una de sus dependencias o dependientes. */
export const DependencyLink = z.strictObject({
  taskId: z.uuid(),
  number: TaskNumber,
  projectId: z.uuid(),
  intent: z.string(),
  title: TaskTitle.nullable(),
  state: TaskState,
  prState: PrState.nullable(),
  // Las dependencias entre proyectos se permiten, pero la UI las muestra como riesgo.
  crossProject: z.boolean(),
  createdAt: z.date(),
});
export type DependencyLink = z.infer<typeof DependencyLink>;

export const TaskDependencies = z.strictObject({
  dependsOn: z.array(DependencyLink),
  dependents: z.array(DependencyLink),
});
export type TaskDependencies = z.infer<typeof TaskDependencies>;

export const TASK_CREATED = "task.created";
export const TASK_UPDATED = "task.updated";
export const TASK_TITLED = "task.titled";
export const TASK_DEPENDENCY_ADDED = "task.dependency_added";
export const TASK_DEPENDENCY_REMOVED = "task.dependency_removed";

export const TaskCreatedPayload = z.strictObject({
  // Opcional: los task.created anteriores al número no lo traen.
  number: TaskNumber.optional(),
  projectId: z.uuid(),
  intent: z.string(),
  tags: z.array(z.string()),
  priority: Priority,
  causedBy: z.uuid().nullable(),
  dependsOn: z.array(z.strictObject({ dependsOnId: z.uuid(), crossProject: z.boolean() })),
});
export type TaskCreatedPayload = z.infer<typeof TaskCreatedPayload>;

const EditableFields = z.strictObject({
  intent: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: Priority.optional(),
});

/** Solo los campos que cambiaron, con su valor anterior y el nuevo. */
export const TaskUpdatedPayload = z
  .strictObject({ from: EditableFields, to: EditableFields })
  .refine((p) => Object.keys(p.to).length > 0, "task.updated sin cambios");
export type TaskUpdatedPayload = z.infer<typeof TaskUpdatedPayload>;

/** El refinador fijó el título de la tarea (solo la primera vez). */
export const TaskTitledPayload = z.strictObject({ title: TaskTitle });
export type TaskTitledPayload = z.infer<typeof TaskTitledPayload>;

/** Payload de task.dependency_added y task.dependency_removed; el evento va en la dependiente. */
export const TaskDependencyPayload = z.strictObject({
  dependsOnId: z.uuid(),
  crossProject: z.boolean(),
});
export type TaskDependencyPayload = z.infer<typeof TaskDependencyPayload>;

/** Filtros de GET /api/tasks. */
export const TaskListQuery = z.strictObject({
  projectId: z.uuid().optional(),
  state: TaskState.optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;
