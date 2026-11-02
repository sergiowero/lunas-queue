// LunasQ SQLite schema (docs/design.md §Domain model, §Usage, §Audit).
// Conventions: UUID text ids except events/outbox (autoincrement, total order),
// times in epoch milliseconds, JSON in text columns and enums with CHECK.
import { randomUUID } from "node:crypto";
import {
  Actor,
  AgentKind,
  Phase,
  PrState,
  type QuestionOptions,
  QuestionStatus,
  ResultKind,
  RiskLabel,
  RunResult,
  SessionSource,
  SpecApproval,
  type SpecContent,
  SpecDeliverable,
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
// Defaults live in SQL so they also apply to writes outside Drizzle.
const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;
const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(nowMs)
    .$onUpdateFn(() => new Date());

/** Values of a Zod enum as a non-empty tuple, the shape Drizzle's `text({ enum })` requires. */
function values<T extends string>(e: { options: readonly T[] }): [T, ...T[]] {
  const [first, ...rest] = e.options;
  if (first === undefined) throw new Error("empty enum");
  return [first, ...rest];
}

/** CHECK that limits a column to the values of an @lunasq/schemas enum (NULL passes). */
function inEnum(name: string, column: AnySQLiteColumn, values: readonly string[]) {
  const list = values.map((v) => `'${v}'`).join(", ");
  return check(name, sql`${column} in (${sql.raw(list)})`);
}

const isInteger = (column: AnySQLiteColumn): SQL => sql`typeof(${column}) = 'integer'`;

const nonNegative = (name: string, column: AnySQLiteColumn) => check(name, sql`${column} >= 0`);

/** Counters: non-negative integers (without the typeof, SQLite would accept reals). */
const unsignedInt = (name: string, column: AnySQLiteColumn) =>
  check(name, sql`${isInteger(column)} and ${column} >= 0`);

export const projects = sqliteTable("projects", {
  id: id(),
  name: text("name").notNull().unique(),
  repo: text("repo").notNull(),
  baseBranch: text("base_branch").notNull(),
  localPath: text("local_path").notNull().unique(),
  // Agent profile per phase and limits; its shape is validated by UW-05 with Zod.
  agentProfiles: text("agent_profiles", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  limits: text("limits", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  testCommand: text("test_command"),
  bootstrap: text("bootstrap"),
  // The project's herdr workspace; herdr is ephemeral, so it is a hint that gets revalidated.
  herdrWorkspaceId: text("herdr_workspace_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: id(),
    // Task number (#N): sequential and global, immutable and never reused; assigned by the
    // tasks_assign_number trigger of migration 0008 if the insert does not bring it (ADR 0015).
    number: integer("number"),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    intent: text("intent").notNull(),
    // Set by the first refinement and never changes again.
    title: text("title"),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
    // Unsigned integer: higher number = higher priority.
    priority: integer("priority").notNull(),
    state: text("state", { enum: values(TaskState) })
      .notNull()
      .default("draft"),
    // Only the states with an agent have a sub-state; consistency with state is UW-04's.
    subState: text("sub_state", { enum: values(SubState) }).default("queued"),
    verificationIteration: integer("verification_iteration").notNull().default(0),
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    prUrl: text("pr_url"),
    prState: text("pr_state", { enum: values(PrState) }),
    riskLabel: text("risk_label", { enum: values(RiskLabel) }),
    // Result of a task completed without code (submit_result, ADR 0007); no PR.
    resultKind: text("result_kind", { enum: values(ResultKind) }),
    result: text("result"),
    causedBy: text("caused_by").references((): AnySQLiteColumn => tasks.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Capped at Number.MAX_SAFE_INTEGER: the column is read as a number in JS.
    check(
      "tasks_priority_unsigned",
      sql`${isInteger(t.priority)} and ${t.priority} between 0 and ${sql.raw(String(Number.MAX_SAFE_INTEGER))}`,
    ),
    unsignedInt("tasks_verification_iteration_unsigned", t.verificationIteration),
    inEnum("tasks_state_enum", t.state, values(TaskState)),
    inEnum("tasks_sub_state_enum", t.subState, values(SubState)),
    inEnum("tasks_pr_state_enum", t.prState, values(PrState)),
    inEnum("tasks_risk_label_enum", t.riskLabel, values(RiskLabel)),
    inEnum("tasks_result_kind_enum", t.resultKind, values(ResultKind)),
    check(
      "tasks_number_positive",
      sql`${t.number} is null or (${isInteger(t.number)} and ${t.number} > 0)`,
    ),
    uniqueIndex("tasks_number_unique").on(t.number),
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
    deliverable: text("deliverable", { enum: values(SpecDeliverable) })
      .notNull()
      .default("code"),
    // Content validated with SpecContent on write; the criteria are addressable by id.
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
    // Author of the version: the refiner or the human who edited it (ADR 0013).
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
    inEnum("specs_deliverable_enum", t.deliverable, values(SpecDeliverable)),
    inEnum("specs_approval_enum", t.approval, values(SpecApproval)),
    inEnum("specs_created_by_enum", t.createdBy, values(Actor)),
    // The approval is tied to a single version per task.
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
    // The task's verification iteration at dispatch: separates rework from retries.
    iteration: integer("iteration").notNull().default(0),
    herdrWorkspace: text("herdr_workspace"),
    herdrPane: text("herdr_pane"),
    herdrName: text("herdr_name"),
    // Agent's native session id or session name, and where it came from.
    agentSession: text("agent_session"),
    agentSessionSource: text("agent_session_source", { enum: values(SessionSource) }),
    runToken: text("run_token").notNull().unique(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
    // The phase prompt was already sent: resuming the dispatch does not repeat it.
    launchedAt: integer("launched_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    result: text("result", { enum: values(RunResult) }),
    failureReason: text("failure_reason"),
    handoff: text("handoff", { mode: "json" }),
    // First call to get_task_context: without it the LunasQ MCP rejects the exit tools.
    contextReadAt: integer("context_read_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    inEnum("runs_phase_enum", t.phase, values(Phase)),
    inEnum("runs_agent_kind_enum", t.agentKind, values(AgentKind)),
    inEnum("runs_result_enum", t.result, values(RunResult)),
    inEnum("runs_agent_session_source_enum", t.agentSessionSource, values(SessionSource)),
    unsignedInt("runs_iteration_unsigned", t.iteration),
    index("runs_task_idx").on(t.taskId),
    // Only the active Run can move the task: at most one without ended_at per task.
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
    // Options proposed by the agent (2 to 6, immutable); null on an open question.
    options: text("options", { mode: "json" }).$type<QuestionOptions>(),
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

// Subagents launched by a Run's session, according to the SubagentStart and SubagentStop hooks
// (ADR uw-19-revisores). A hook can be lost or repeated: either of the two creates the row.
export const runSubagents = sqliteTable(
  "run_subagents",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // Claude Code's agent_id: unique within the session.
    agentId: text("agent_id").notNull(),
    agentType: text("agent_type").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    stoppedAt: integer("stopped_at", { mode: "timestamp_ms" }),
    transcriptPath: text("transcript_path"),
  },
  (t) => [unique("run_subagents_run_agent_unique").on(t.runId, t.agentId)],
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
    // Estimated in USD; NULL when the agent does not report it and it is not computed yet.
    costUsd: real("cost_usd"),
    source: text("source", { enum: values(UsageSource) }).notNull(),
    // Message or request id at the source; deduplicates OTel or transcript re-ingestions.
    sourceRef: text("source_ref"),
    // agent_id of the subagent that made the call (Claude Code api_request event); NULL if it was the
    // main session. It joins with run_subagents for the per-reviewer breakdown.
    agentId: text("agent_id"),
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
    // Append-only: a task with events cannot be deleted. Null on global events
    // (settings.updated), which do not belong to any task.
    taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
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

/** Global key/value configuration (e.g. "providers": AgentProviderSettings). */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: updatedAt(),
});

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
