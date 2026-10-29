// Esquema SQLite de LunasQ (docs/design.md §Modelo de dominio, §Consumo, §Auditoría).
// Convenciones: ids de texto UUID salvo events/outbox (autoincrement, orden total),
// tiempos en milisegundos epoch, JSON en columnas de texto y enums con CHECK.
import { randomUUID } from "node:crypto";
import {
  Actor,
  AgentKind,
  Phase,
  PrState,
  QuestionStatus,
  RiskLabel,
  RunResult,
  SpecApproval,
  type SpecContent,
  SubState,
  TaskState,
  UsageSource,
} from "@lunasq/schemas";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());
// Los defaults viven en SQL para que también apliquen a escrituras fuera de Drizzle.
const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(nowMs)
    .$onUpdateFn(() => new Date());

/** Valores de un enum Zod como tupla no vacía, la forma que pide `text({ enum })` de Drizzle. */
function values<T extends string>(e: { options: readonly T[] }): [T, ...T[]] {
  const [first, ...rest] = e.options;
  if (first === undefined) throw new Error("enum vacío");
  return [first, ...rest];
}

/** CHECK que limita una columna a los valores de un enum de @lunasq/schemas (NULL pasa). */
function inEnum(name: string, column: AnySQLiteColumn, values: readonly string[]) {
  const list = values.map((v) => `'${v}'`).join(", ");
  return check(name, sql`${column} in (${sql.raw(list)})`);
}

const isInteger = (column: AnySQLiteColumn): SQL => sql`typeof(${column}) = 'integer'`;

const nonNegative = (name: string, column: AnySQLiteColumn) => check(name, sql`${column} >= 0`);

/** Contadores: enteros no negativos (sin el typeof, SQLite aceptaría reales). */
const unsignedInt = (name: string, column: AnySQLiteColumn) =>
  check(name, sql`${isInteger(column)} and ${column} >= 0`);

export const projects = sqliteTable("projects", {
  id: id(),
  name: text("name").notNull().unique(),
  repo: text("repo").notNull(),
  baseBranch: text("base_branch").notNull(),
  localPath: text("local_path").notNull().unique(),
  // Perfil de agente por fase y límites; su forma la valida UW-05 con Zod.
  agentProfiles: text("agent_profiles", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  limits: text("limits", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  testCommand: text("test_command"),
  bootstrap: text("bootstrap"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    intent: text("intent").notNull(),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
    // Entero sin signo: mayor número = mayor prioridad.
    priority: integer("priority").notNull(),
    state: text("state", { enum: values(TaskState) })
      .notNull()
      .default("draft"),
    // Solo los estados con agente tienen sub-estado; la coherencia con state es de UW-04.
    subState: text("sub_state", { enum: values(SubState) }).default("queued"),
    verificationIteration: integer("verification_iteration").notNull().default(0),
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    prUrl: text("pr_url"),
    prState: text("pr_state", { enum: values(PrState) }),
    riskLabel: text("risk_label", { enum: values(RiskLabel) }),
    causedBy: text("caused_by").references((): AnySQLiteColumn => tasks.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Tope en Number.MAX_SAFE_INTEGER: la columna se lee como number en JS.
    check(
      "tasks_priority_unsigned",
      sql`${isInteger(t.priority)} and ${t.priority} between 0 and ${sql.raw(String(Number.MAX_SAFE_INTEGER))}`,
    ),
    unsignedInt("tasks_verification_iteration_unsigned", t.verificationIteration),
    inEnum("tasks_state_enum", t.state, values(TaskState)),
    inEnum("tasks_sub_state_enum", t.subState, values(SubState)),
    inEnum("tasks_pr_state_enum", t.prState, values(PrState)),
    inEnum("tasks_risk_label_enum", t.riskLabel, values(RiskLabel)),
    index("tasks_project_idx").on(t.projectId),
    index("tasks_state_idx").on(t.state, t.subState),
  ],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnId] }),
    check("task_dependencies_no_self_loop", sql`${t.taskId} <> ${t.dependsOnId}`),
    index("task_dependencies_depends_on_idx").on(t.dependsOnId),
  ],
);

export const specs = sqliteTable(
  "specs",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // Contenido validado con SpecContent al escribir; los criterios son direccionables por id.
    domainModel: text("domain_model", { mode: "json" }).$type<SpecContent["domainModel"]>(),
    requirements: text("requirements", { mode: "json" }).$type<SpecContent["requirements"]>(),
    acceptanceCriteria: text("acceptance_criteria", { mode: "json" })
      .$type<SpecContent["criteria"]>()
      .notNull()
      .default([]),
    taskList: text("task_list", { mode: "json" }).$type<SpecContent["taskList"]>(),
    approval: text("approval", { enum: values(SpecApproval) })
      .notNull()
      .default("pending"),
    // Autor de la versión: el refinador o el humano que la editó (ADR 0013).
    createdBy: text("created_by", { enum: values(Actor) })
      .notNull()
      .default("agent"),
    approvedBy: text("approved_by", { enum: values(Actor) }),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    reviewComments: text("review_comments"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("specs_task_version_unique").on(t.taskId, t.version),
    check("specs_version_positive", sql`${t.version} >= 1`),
    inEnum("specs_approval_enum", t.approval, values(SpecApproval)),
    inEnum("specs_created_by_enum", t.createdBy, values(Actor)),
    // La aprobación se liga a una sola versión por tarea.
    uniqueIndex("specs_one_approved_per_task").on(t.taskId).where(sql`${t.approval} = 'approved'`),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    phase: text("phase", { enum: values(Phase) }).notNull(),
    agentKind: text("agent_kind", { enum: values(AgentKind) }).notNull(),
    model: text("model"),
    // Iteración de verificación de la tarea al despachar: separa rework de reintentos.
    iteration: integer("iteration").notNull().default(0),
    herdrWorkspace: text("herdr_workspace"),
    herdrPane: text("herdr_pane"),
    herdrName: text("herdr_name"),
    // Session id nativo del agente o nombre de sesión.
    agentSession: text("agent_session"),
    runToken: text("run_token").notNull().unique(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    result: text("result", { enum: values(RunResult) }),
    failureReason: text("failure_reason"),
    handoff: text("handoff", { mode: "json" }),
  },
  (t) => [
    inEnum("runs_phase_enum", t.phase, values(Phase)),
    inEnum("runs_agent_kind_enum", t.agentKind, values(AgentKind)),
    inEnum("runs_result_enum", t.result, values(RunResult)),
    unsignedInt("runs_iteration_unsigned", t.iteration),
    index("runs_task_idx").on(t.taskId),
    // Solo el Run activo puede mover la tarea: a lo sumo uno sin ended_at por tarea.
    uniqueIndex("runs_one_active_per_task").on(t.taskId).where(sql`${t.endedAt} is null`),
  ],
);

export const questions = sqliteTable(
  "questions",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    question: text("question").notNull(),
    context: text("context"),
    status: text("status", { enum: values(QuestionStatus) })
      .notNull()
      .default("open"),
    answer: text("answer"),
    answeredBy: text("answered_by"),
    answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    inEnum("questions_status_enum", t.status, values(QuestionStatus)),
    index("questions_task_idx").on(t.taskId),
    index("questions_run_idx").on(t.runId),
    index("questions_status_idx").on(t.status),
  ],
);

export const usageRecords = sqliteTable(
  "usage_records",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    // Estimado en USD; NULL cuando el agente no lo reporta y aún no se calcula.
    costUsd: real("cost_usd"),
    source: text("source", { enum: values(UsageSource) }).notNull(),
    // Id del mensaje o request en la fuente; deduplica reingestas de OTel o transcript.
    sourceRef: text("source_ref"),
    pricingVersion: text("pricing_version"),
    createdAt: createdAt(),
  },
  (t) => [
    unsignedInt("usage_records_input_tokens_unsigned", t.inputTokens),
    unsignedInt("usage_records_output_tokens_unsigned", t.outputTokens),
    unsignedInt("usage_records_cache_read_tokens_unsigned", t.cacheReadTokens),
    unsignedInt("usage_records_cache_write_tokens_unsigned", t.cacheWriteTokens),
    nonNegative("usage_records_cost_usd_nonneg", t.costUsd),
    inEnum("usage_records_source_enum", t.source, values(UsageSource)),
    index("usage_records_run_idx").on(t.runId),
    unique("usage_records_source_ref_unique").on(t.runId, t.source, t.sourceRef),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Append-only: una tarea con eventos no se puede borrar.
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    actor: text("actor", { enum: values(Actor) }).notNull(),
    payload: text("payload", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [
    inEnum("events_actor_enum", t.actor, values(Actor)),
    index("events_task_idx").on(t.taskId, t.id),
  ],
);

export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .unique()
      .references(() => events.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    payload: text("payload", { mode: "json" }),
    createdAt: createdAt(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    unsignedInt("outbox_attempts_unsigned", t.attempts),
    index("outbox_pending_idx").on(t.id).where(sql`${t.publishedAt} is null`),
  ],
);
