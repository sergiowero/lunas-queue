// Specs versionadas y su aprobación (docs/design.md §Human-in-the-loop, ADR 0013). Cada
// escritura corre en una transacción IMMEDIATE que guarda la versión, su evento y la transición
// de la tarea juntos: si la máquina de estados la rechaza, no queda nada escrito. Los payloads
// se validan con su esquema antes de entrar al Event log.
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
  // La versión no es la última de la tarea: el humano revisó una versión superada.
  | "stale_version"
  // La versión ya se aprobó o ya se pidieron cambios.
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

// Revierte la transacción de una escritura rechazada y lleva el rechazo a quien llama.
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
    throw new SpecRepositoryError(`spec inválida en ${row.id}`, { cause: result.error });
  }
  return result.data;
}

const contentColumns = (content: SpecContent) => ({
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
   * El refinador entrega una versión nueva (submit_spec): draft/running → refined. Valida
   * `content` (lanza ZodError si no cumple); la transición recibe el hecho specComplete.
   */
  submit(taskId: string, content: SpecContent): SpecResult {
    const parsed = SpecContent.parse(content);
    return this.#write((tx) => this.#submit(tx, taskId, parsed));
  }

  /**
   * Como submit, dentro de una transacción IMMEDIATE que ya abrió quien llama: el LunasQ MCP
   * cierra el Run del refinador en la misma transacción. Un rechazo no escribe la transición,
   * pero la versión sí: quien llama debe revertir la transacción.
   */
  applySubmit(tx: Tx, taskId: string, content: SpecContent): SpecResult {
    return this.#submit(tx, taskId, SpecContent.parse(content));
  }

  #submit(tx: Tx, taskId: string, content: SpecContent): SpecResult {
    if (!taskExists(tx, taskId)) return fail("task_not_found", `no existe la tarea ${taskId}`);
    const spec = this.#insertVersion(tx, taskId, content, "agent", null);
    return this.#transition(tx, taskId, "agent", { type: "submit_spec", specComplete: true }, spec);
  }

  /** El humano aprueba la última versión: refined → in_progress. */
  approve(taskId: string, version: number): SpecResult {
    return this.#write((tx) => {
      const pending = this.#pendingLatest(tx, taskId, version);
      if (!pending.ok) return pending;
      const spec = this.#markApproved(tx, pending.row.id);
      return this.#transition(tx, taskId, "human", { type: "approve", specApproved: true }, spec);
    });
  }

  /** El humano pide cambios con comentarios: refined → draft, para otra ronda de refinamiento. */
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
      if (!row) throw new Error("update de spec sin fila");
      const command = { type: "request_changes", hasComments: trimmed.length > 0 } as const;
      // Sin comentarios no hay evento que escribir: la máquina de estados rechaza con
      // guard_failed y la transacción se revierte.
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
   * El humano edita la última versión y la aprueba en un paso: se crea la versión siguiente
   * con autor humano, ya aprobada. La versión base queda pending y superada.
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

  /** Versiones de la tarea, de la primera a la última. null si la tarea no existe. */
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

  /** La versión aprobada: la que leen implementación y verificación. */
  approved(taskId: string): Spec | null {
    const row = this.db
      .select()
      .from(specs)
      .where(and(eq(specs.taskId, taskId), eq(specs.approval, "approved")))
      .get();
    return row ? toSpec(row) : null;
  }

  /**
   * Cambios de `against` (por defecto la versión anterior) a `version`. Sin versión anterior
   * todo aparece como agregado. null si alguna de las dos no existe.
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
    if (!taskExists(tx, taskId)) return fail("task_not_found", `no existe la tarea ${taskId}`);
    const row = findVersion(tx, taskId, version);
    if (!row) return fail("spec_not_found", `la tarea ${taskId} no tiene la versión ${version}`);
    const latest = latestVersion(tx, taskId);
    if (version !== latest) {
      return fail("stale_version", `la versión ${version} fue superada por la ${latest}`);
    }
    if (row.approval !== "pending") {
      return fail("spec_not_pending", `la versión ${version} ya está en ${row.approval}`);
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
    if (!row) throw new Error("insert de spec sin fila");
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
    if (!row) throw new Error("update de spec sin fila");
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
