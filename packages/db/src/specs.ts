// Versioned specs and their approval (docs/design.md §Human-in-the-loop, ADR 0013). Each
// write runs in an IMMEDIATE transaction that saves the version, its event and the task
// transition together: if the state machine rejects it, nothing is left written. The payloads
// are validated with their schema before entering the Event log.
import { diffSpecContent, isEmptyDiff } from "@lunasq/domain";
import {
  type Actor,
  SPEC_APPROVED,
  SPEC_CHANGES_REQUESTED,
  SPEC_VERSION_CREATED,
  Spec,
  SpecApprovedPayload,
  SpecChangesRequestedPayload,
  SpecContent,
  type SpecDiff,
  SpecVersionCreatedPayload,
  Task,
} from "@lunasq/schemas";
import { and, asc, desc, eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { specs, tasks } from "./schema.ts";
import {
  applyTransition,
  type TransitionCommand,
  type TransitionTaskErrorCode,
  type Tx,
} from "./task-transitions.ts";

export type SpecErrorCode =
  | TransitionTaskErrorCode
  | "spec_not_found"
  // The version is not the task's latest: the human reviewed a superseded version.
  | "stale_version"
  // The version was already approved or changes were already requested.
  | "spec_not_pending";

export type SpecResult =
  | { ok: true; spec: Spec; task: Task }
  | { ok: false; error: { code: SpecErrorCode; message: string } };

type Failure = Extract<SpecResult, { ok: false }>;
type Row = typeof specs.$inferSelect;
type Reader = Pick<LunasqDatabase, "select">;

export class SpecRepositoryError extends Error {
  readonly code = "invalid_row";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpecRepositoryError";
  }
}

// Rolls back the transaction of a rejected write and carries the rejection to the caller.
class Rejected extends Error {
  readonly result: Failure;

  constructor(result: Failure) {
    super(result.error.message);
    this.result = result;
  }
}

const fail = (code: SpecErrorCode, message: string): Failure => ({
  ok: false,
  error: { code, message },
});

function toSpec(row: Row): Spec {
  const result = Spec.safeParse({
    id: row.id,
    taskId: row.taskId,
    version: row.version,
    content: {
      deliverable: row.deliverable,
      domainModel: row.domainModel,
      requirements: row.requirements,
      criteria: row.acceptanceCriteria,
      taskList: row.taskList,
    },
    approval: row.approval,
    createdBy: row.createdBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    reviewComments: row.reviewComments,
    createdAt: row.createdAt,
  });
  if (!result.success) {
    throw new SpecRepositoryError(`invalid spec in ${row.id}`, { cause: result.error });
  }
  return result.data;
}

const contentColumns = (content: SpecContent) => ({
  deliverable: content.deliverable,
  domainModel: content.domainModel,
  requirements: content.requirements,
  acceptanceCriteria: content.criteria,
  taskList: content.taskList,
});

function taskExists(db: Reader, taskId: string): boolean {
  return db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get() !== undefined;
}

function findVersion(db: Reader, taskId: string, version: number): Row | undefined {
  return db
    .select()
    .from(specs)
    .where(and(eq(specs.taskId, taskId), eq(specs.version, version)))
    .get();
}

function latestVersion(db: Reader, taskId: string): number {
  const row = db
    .select({ version: specs.version })
    .from(specs)
    .where(eq(specs.taskId, taskId))
    .orderBy(desc(specs.version))
    .limit(1)
    .get();
  return row?.version ?? 0;
}

export class SpecRepository {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  /**
   * The refiner delivers a new version (submit_spec): draft/running → refined. Validates
   * `content` (throws ZodError if it does not comply); the transition receives the specComplete fact.
   */
  submit(taskId: string, content: SpecContent): SpecResult {
    const parsed = SpecContent.parse(content);
    return this.#write((tx) => this.#submit(tx, taskId, parsed));
  }

  /**
   * Like submit, inside an IMMEDIATE transaction already opened by the caller: the LunasQ MCP
   * closes the refiner's Run in the same transaction. A rejection does not write the transition,
   * but the version is written: the caller must roll the transaction back.
   */
  applySubmit(tx: Tx, taskId: string, content: SpecContent): SpecResult {
    return this.#submit(tx, taskId, SpecContent.parse(content));
  }

  #submit(tx: Tx, taskId: string, content: SpecContent): SpecResult {
    if (!taskExists(tx, taskId)) return fail("task_not_found", `task ${taskId} does not exist`);
    const spec = this.#insertVersion(tx, taskId, content, "agent", null);
    return this.#transition(tx, taskId, "agent", { type: "submit_spec", specComplete: true }, spec);
  }

  /** The human approves the latest version: refined → in_progress. */
  approve(taskId: string, version: number): SpecResult {
    return this.#write((tx) => {
      const pending = this.#pendingLatest(tx, taskId, version);
      if (!pending.ok) return pending;
      const spec = this.#markApproved(tx, pending.row.id);
      return this.#transition(tx, taskId, "human", { type: "approve", specApproved: true }, spec);
    });
  }

  /** The human requests changes with comments: refined → draft, for another refinement round. */
  requestChanges(taskId: string, version: number, comments: string): SpecResult {
    const trimmed = comments.trim();
    return this.#write((tx) => {
      const pending = this.#pendingLatest(tx, taskId, version);
      if (!pending.ok) return pending;
      const [row] = tx
        .update(specs)
        .set({ approval: "changes_requested", reviewComments: trimmed })
        .where(eq(specs.id, pending.row.id))
        .returning()
        .all();
      if (!row) throw new Error("spec update without a row");
      const command = { type: "request_changes", hasComments: trimmed.length > 0 } as const;
      // Without comments there is no event to write: the state machine rejects with
      // guard_failed and the transaction is rolled back.
      if (command.hasComments) {
        const payload = SpecChangesRequestedPayload.parse({
          specId: row.id,
          version: row.version,
          comments: trimmed,
        });
        appendEvent(tx, { taskId, type: SPEC_CHANGES_REQUESTED, actor: "human", payload });
      }
      return this.#transition(tx, taskId, "human", command, toSpec(row));
    });
  }

  /**
   * The human edits the latest version and approves it in one step: the next version is created
   * with human author, already approved. The base version stays pending and superseded.
   */
  editAndApprove(taskId: string, baseVersion: number, content: SpecContent): SpecResult {
    const parsed = SpecContent.parse(content);
    return this.#write((tx) => {
      const pending = this.#pendingLatest(tx, taskId, baseVersion);
      if (!pending.ok) return pending;
      const created = this.#insertVersion(tx, taskId, parsed, "human", baseVersion);
      const spec = this.#markApproved(tx, created.id);
      return this.#transition(tx, taskId, "human", { type: "approve", specApproved: true }, spec);
    });
  }

  /** Versions of the task, from first to last. null if the task does not exist. */
  list(taskId: string): Spec[] | null {
    return this.db.transaction((tx) => {
      if (!taskExists(tx, taskId)) return null;
      return tx
        .select()
        .from(specs)
        .where(eq(specs.taskId, taskId))
        .orderBy(asc(specs.version))
        .all()
        .map(toSpec);
    });
  }

  get(taskId: string, version: number): Spec | null {
    const row = findVersion(this.db, taskId, version);
    return row ? toSpec(row) : null;
  }

  /** The approved version: the one implementation and verification read. */
  approved(taskId: string): Spec | null {
    const row = this.db
      .select()
      .from(specs)
      .where(and(eq(specs.taskId, taskId), eq(specs.approval, "approved")))
      .get();
    return row ? toSpec(row) : null;
  }

  /**
   * Changes from `against` (by default the previous version) to `version`. Without a previous version
   * everything appears as added. null if either of the two does not exist.
   */
  diff(taskId: string, version: number, against?: number): SpecDiff | null {
    return this.db.transaction((tx) => {
      const to = findVersion(tx, taskId, version);
      if (!to) return null;
      const fromVersion = against ?? (version > 1 ? version - 1 : null);
      const from = fromVersion === null ? null : findVersion(tx, taskId, fromVersion);
      if (from === undefined) return null;
      const changes = diffSpecContent(from ? toSpec(from).content : null, toSpec(to).content);
      return { from: fromVersion, to: version, identical: isEmptyDiff(changes), changes };
    });
  }

  #pendingLatest(tx: Tx, taskId: string, version: number): { ok: true; row: Row } | Failure {
    if (!taskExists(tx, taskId)) return fail("task_not_found", `task ${taskId} does not exist`);
    const row = findVersion(tx, taskId, version);
    if (!row) return fail("spec_not_found", `task ${taskId} does not have version ${version}`);
    const latest = latestVersion(tx, taskId);
    if (version !== latest) {
      return fail("stale_version", `version ${version} was superseded by ${latest}`);
    }
    if (row.approval !== "pending") {
      return fail("spec_not_pending", `version ${version} is already ${row.approval}`);
    }
    return { ok: true, row };
  }

  #insertVersion(
    tx: Tx,
    taskId: string,
    content: SpecContent,
    author: Actor,
    basedOn: number | null,
  ): Row {
    const [row] = tx
      .insert(specs)
      .values({
        taskId,
        version: latestVersion(tx, taskId) + 1,
        ...contentColumns(content),
        createdBy: author,
      })
      .returning()
      .all();
    if (!row) throw new Error("spec insert without a row");
    const payload = SpecVersionCreatedPayload.parse({
      specId: row.id,
      version: row.version,
      basedOn,
    });
    appendEvent(tx, { taskId, type: SPEC_VERSION_CREATED, actor: author, payload });
    return row;
  }

  #markApproved(tx: Tx, specId: string): Spec {
    const [row] = tx
      .update(specs)
      .set({ approval: "approved", approvedBy: "human", approvedAt: new Date() })
      .where(eq(specs.id, specId))
      .returning()
      .all();
    if (!row) throw new Error("spec update without a row");
    const payload = SpecApprovedPayload.parse({ specId: row.id, version: row.version });
    appendEvent(tx, { taskId: row.taskId, type: SPEC_APPROVED, actor: "human", payload });
    return toSpec(row);
  }

  #transition(
    tx: Tx,
    taskId: string,
    actor: Actor,
    command: TransitionCommand,
    spec: Row | Spec,
  ): SpecResult {
    const result = applyTransition(tx, { taskId, actor, command });
    if (!result.ok) return result;
    return {
      ok: true,
      spec: "content" in spec ? spec : toSpec(spec),
      task: Task.parse(result.task),
    };
  }

  #write(fn: (tx: Tx) => SpecResult): SpecResult {
    try {
      return this.db.transaction(
        (tx) => {
          const result = fn(tx);
          if (!result.ok) throw new Rejected(result);
          return result;
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      throw error;
    }
  }
}
