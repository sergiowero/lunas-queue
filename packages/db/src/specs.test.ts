import {
  SPEC_APPROVED,
  SPEC_CHANGES_REQUESTED,
  SPEC_VERSION_CREATED,
  type SpecContent,
  TASK_TRANSITIONED,
} from "@lunasq/schemas";
import { specContentExample } from "@lunasq/schemas/testing";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { type LunasqDatabase, migrateDatabase } from "./client.ts";
import { listEvents } from "./event-log.ts";
import * as schema from "./schema.ts";
import { outbox, specs, tasks } from "./schema.ts";
import { SpecRepository, type SpecResult } from "./specs.ts";
import { transitionTask } from "./task-transitions.ts";
import { freshDatabase, insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

const missing = "00000000-0000-4000-8000-000000000999";

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const repo = new SpecRepository(db);
  // El refinador corre: la tarea está en draft/running.
  const refining = () => insertTask(db, project.id, { state: "draft", subState: "running" });
  const taskRow = (id: string) => db.select().from(tasks).where(eq(tasks.id, id)).get();
  const eventTypes = (id: string) => listEvents(db, id).map((e) => e.type);
  return { db, repo, refining, taskRow, eventTypes };
}

function ok(result: SpecResult) {
  if (!result.ok) throw new Error(`se esperaba ok: ${result.error.code} ${result.error.message}`);
  return result;
}

function failed(result: SpecResult) {
  if (result.ok) throw new Error("se esperaba un rechazo");
  return result.error;
}

/** Contenido distinto al del ejemplo, para las versiones siguientes. */
function revised(): SpecContent {
  const content = specContentExample();
  content.requirements.push("El cliente recibe un correo al cancelar");
  return content;
}

describe("SpecRepository.submit", () => {
  it("crea la versión 1 de autor agente y pasa la tarea a refined", () => {
    const { db, repo, refining, taskRow, eventTypes } = setup();
    const task = refining();
    const { spec, task: moved } = ok(repo.submit(task.id, specContentExample()));
    expect(spec).toMatchObject({
      taskId: task.id,
      version: 1,
      content: specContentExample(),
      approval: "pending",
      createdBy: "agent",
      approvedBy: null,
      approvedAt: null,
    });
    expect(moved).toMatchObject({ state: "refined", subState: null });
    expect(taskRow(task.id)).toMatchObject({ state: "refined", subState: null });
    expect(eventTypes(task.id)).toEqual([SPEC_VERSION_CREATED, TASK_TRANSITIONED]);
    const [created] = listEvents(db, task.id);
    expect(created).toMatchObject({
      actor: "agent",
      payload: { specId: spec.id, version: 1, basedOn: null },
    });
  });

  it("numera las versiones de cada tarea en orden", () => {
    const { db, repo, refining } = setup();
    const task = refining();
    const other = refining();
    ok(repo.submit(task.id, specContentExample()));
    ok(repo.requestChanges(task.id, 1, "Falta el caso de pedido enviado"));
    // La reconciliación despacha otra vez al refinador.
    setRunning(db, task.id);
    expect(ok(repo.submit(task.id, revised())).spec.version).toBe(2);
    expect(ok(repo.submit(other.id, specContentExample())).spec.version).toBe(1);
    expect(repo.list(task.id)?.map((s) => s.version)).toEqual([1, 2]);
  });

  it("valida el contenido antes de escribir", () => {
    const { db, repo, refining } = setup();
    const task = refining();
    expect(() => repo.submit(task.id, { ...specContentExample(), criteria: [] })).toThrow(
      expect.objectContaining({ name: "ZodError" }),
    );
    expect(db.select().from(specs).all()).toEqual([]);
  });

  it("si la transición se rechaza no queda versión ni evento", () => {
    const { db, repo, eventTypes } = setup();
    const project = insertProject(db);
    const queued = insertTask(db, project.id, { state: "draft", subState: "queued" });
    expect(failed(repo.submit(queued.id, specContentExample())).code).toBe("invalid_transition");
    expect(db.select().from(specs).all()).toEqual([]);
    expect(eventTypes(queued.id)).toEqual([]);
  });

  it("tarea inexistente", () => {
    const { repo } = setup();
    expect(failed(repo.submit(missing, specContentExample())).code).toBe("task_not_found");
  });
});

describe("SpecRepository.approve", () => {
  function submitted() {
    const ctx = setup();
    const task = ctx.refining();
    ok(ctx.repo.submit(task.id, specContentExample()));
    return { ...ctx, task };
  }

  it("liga la aprobación a la versión exacta y pasa la tarea a in_progress/queued", () => {
    const { db, repo, task, taskRow, eventTypes } = submitted();
    const { spec } = ok(repo.approve(task.id, 1));
    expect(spec).toMatchObject({ version: 1, approval: "approved", approvedBy: "human" });
    expect(spec.approvedAt).toBeInstanceOf(Date);
    expect(taskRow(task.id)).toMatchObject({ state: "in_progress", subState: "queued" });
    expect(repo.approved(task.id)).toEqual(spec);
    expect(eventTypes(task.id).slice(-2)).toEqual([SPEC_APPROVED, TASK_TRANSITIONED]);
    const approvedEvent = listEvents(db, task.id).at(-2);
    expect(approvedEvent).toMatchObject({
      actor: "human",
      payload: { specId: spec.id, version: 1 },
    });
  });

  it("solo se aprueba la última versión: una vieja responde stale_version sin escribir", () => {
    const { db, repo, task, taskRow, eventTypes } = submitted();
    ok(repo.requestChanges(task.id, 1, "Falta el caso de pedido enviado"));
    setRunning(db, task.id);
    ok(repo.submit(task.id, revised()));
    const before = eventTypes(task.id);
    expect(failed(repo.approve(task.id, 1)).code).toBe("stale_version");
    expect(taskRow(task.id)).toMatchObject({ state: "refined" });
    expect(repo.get(task.id, 1)?.approval).toBe("changes_requested");
    expect(eventTypes(task.id)).toEqual(before);
    expect(repo.approved(task.id)).toBeNull();
    expect(ok(repo.approve(task.id, 2)).spec.version).toBe(2);
    expect(repo.approved(task.id)?.content).toEqual(revised());
  });

  it("repetir la aprobación no duplica efectos", () => {
    const { repo, task, eventTypes } = submitted();
    ok(repo.approve(task.id, 1));
    const before = eventTypes(task.id);
    expect(failed(repo.approve(task.id, 1)).code).toBe("spec_not_pending");
    expect(eventTypes(task.id)).toEqual(before);
  });

  it("si la transición se rechaza la spec sigue pending", () => {
    const { db, repo, task } = submitted();
    // Otro proceso canceló la tarea mientras el humano revisaba.
    db.update(tasks).set({ state: "cancelled", subState: null }).where(eq(tasks.id, task.id)).run();
    expect(failed(repo.approve(task.id, 1)).code).toBe("invalid_transition");
    expect(repo.get(task.id, 1)).toMatchObject({ approval: "pending", approvedAt: null });
    expect(repo.approved(task.id)).toBeNull();
  });

  it("versión o tarea inexistentes", () => {
    const { repo, task } = submitted();
    expect(failed(repo.approve(task.id, 7)).code).toBe("spec_not_found");
    expect(failed(repo.approve(missing, 1)).code).toBe("task_not_found");
  });
});

describe("SpecRepository.requestChanges", () => {
  it("regresa la tarea a draft/queued con los comentarios en la versión y en el evento", () => {
    const { db, repo, refining, taskRow, eventTypes } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    const { spec, task: moved } = ok(
      repo.requestChanges(task.id, 1, "  Falta el caso de pedido enviado  "),
    );
    expect(spec).toMatchObject({
      version: 1,
      approval: "changes_requested",
      reviewComments: "Falta el caso de pedido enviado",
    });
    expect(moved).toMatchObject({ state: "draft", subState: "queued" });
    expect(taskRow(task.id)).toMatchObject({ state: "draft", subState: "queued" });
    expect(eventTypes(task.id).slice(-2)).toEqual([SPEC_CHANGES_REQUESTED, TASK_TRANSITIONED]);
    expect(listEvents(db, task.id).at(-2)).toMatchObject({
      actor: "human",
      payload: { specId: spec.id, version: 1, comments: "Falta el caso de pedido enviado" },
    });
    // El cambio de estado sale por el outbox hacia scheduler y dispatcher.
    expect(db.select().from(outbox).all()).toHaveLength(2);
  });

  it("sin comentarios se rechaza sin escribir", () => {
    const { repo, refining, taskRow } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    const error = failed(repo.requestChanges(task.id, 1, "   "));
    expect(error.code).toBe("guard_failed");
    expect(repo.get(task.id, 1)).toMatchObject({ approval: "pending", reviewComments: null });
    expect(taskRow(task.id)).toMatchObject({ state: "refined" });
  });

  it("no aplica a una versión ya aprobada", () => {
    const { repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    ok(repo.approve(task.id, 1));
    expect(failed(repo.requestChanges(task.id, 1, "tarde")).code).toBe("spec_not_pending");
  });
});

describe("SpecRepository.editAndApprove", () => {
  it("crea la versión siguiente de autor humano y la aprueba en un paso", () => {
    const { db, repo, refining, taskRow, eventTypes } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    const { spec } = ok(repo.editAndApprove(task.id, 1, revised()));
    expect(spec).toMatchObject({
      version: 2,
      content: revised(),
      createdBy: "human",
      approval: "approved",
      approvedBy: "human",
    });
    expect(repo.approved(task.id)?.version).toBe(2);
    expect(repo.get(task.id, 1)?.approval).toBe("pending");
    expect(taskRow(task.id)).toMatchObject({ state: "in_progress", subState: "queued" });
    expect(eventTypes(task.id).slice(-3)).toEqual([
      SPEC_VERSION_CREATED,
      SPEC_APPROVED,
      TASK_TRANSITIONED,
    ]);
    expect(listEvents(db, task.id).at(-3)).toMatchObject({
      actor: "human",
      payload: { specId: spec.id, version: 2, basedOn: 1 },
    });
  });

  it("parte de la última versión pendiente", () => {
    const { db, repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    ok(repo.requestChanges(task.id, 1, "otra ronda"));
    setRunning(db, task.id);
    ok(repo.submit(task.id, revised()));
    expect(failed(repo.editAndApprove(task.id, 1, revised())).code).toBe("stale_version");
    expect(db.select().from(specs).all()).toHaveLength(2);
  });

  it("si la transición se rechaza no queda la versión editada", () => {
    const { db, repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    db.update(tasks).set({ state: "cancelled", subState: null }).where(eq(tasks.id, task.id)).run();
    expect(failed(repo.editAndApprove(task.id, 1, revised())).code).toBe("invalid_transition");
    expect(repo.list(task.id)?.map((s) => s.version)).toEqual([1]);
  });

  it("valida el contenido editado", () => {
    const { repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    expect(() =>
      repo.editAndApprove(task.id, 1, { ...revised(), taskList: [] } as SpecContent),
    ).toThrow(expect.objectContaining({ name: "ZodError" }));
  });
});

describe("SpecRepository: concurrencia", () => {
  it("las escrituras toman el lock de escritura antes de leer", () => {
    const { db: first, file } = freshDatabase();
    migrateDatabase(first);
    const project = insertProject(first);
    const task = insertTask(first, project.id, { state: "draft", subState: "running" });
    ok(new SpecRepository(first).submit(task.id, specContentExample()));
    // Segunda conexión, como la de otro proceso, que registra cada consulta que ejecuta.
    const queries: string[] = [];
    const client = new Database(file);
    client.pragma("busy_timeout = 0");
    const second = drizzle({ client, schema, logger: { logQuery: (q) => queries.push(q) } });
    try {
      first.$client.prepare("BEGIN IMMEDIATE").run();
      // Sin IMMEDIATE, dos aprobaciones leerían la misma versión pendiente a la vez.
      expect(() => new SpecRepository(second).approve(task.id, 1)).toThrow(/locked|busy/i);
      expect(() => new SpecRepository(second).submit(task.id, revised())).toThrow(/locked|busy/i);
      expect(queries).toEqual([]);
      first.$client.prepare("ROLLBACK").run();
      expect(new SpecRepository(second).approve(task.id, 1).ok).toBe(true);
    } finally {
      client.close();
    }
  });
});

describe("SpecRepository: lecturas y diff", () => {
  it("list y get devuelven null si la tarea o la versión no existen", () => {
    const { repo, refining } = setup();
    const task = refining();
    expect(repo.list(task.id)).toEqual([]);
    expect(repo.list(missing)).toBeNull();
    expect(repo.get(task.id, 1)).toBeNull();
    expect(repo.approved(task.id)).toBeNull();
  });

  it("diff contra la versión anterior por defecto, o contra la indicada", () => {
    const { repo, refining } = setup();
    const task = refining();
    ok(repo.submit(task.id, specContentExample()));
    ok(repo.editAndApprove(task.id, 1, revised()));
    const diff = repo.diff(task.id, 2);
    expect(diff).toMatchObject({ from: 1, to: 2, identical: false });
    expect(diff?.changes.requirements.added).toEqual(["El cliente recibe un correo al cancelar"]);
    expect(repo.diff(task.id, 2, 2)).toMatchObject({ from: 2, to: 2, identical: true });
    const first = repo.diff(task.id, 1);
    expect(first).toMatchObject({ from: null, to: 1, identical: false });
    expect(first?.changes.criteria.added).toHaveLength(2);
    expect(repo.diff(task.id, 3)).toBeNull();
    expect(repo.diff(task.id, 2, 9)).toBeNull();
  });
});

// El dispatcher (UW-16) despacha otra vez al refinador: draft/queued → draft/running.
function setRunning(db: LunasqDatabase, taskId: string) {
  const result = transitionTask(db, { taskId, actor: "system", command: { type: "dispatch" } });
  if (!result.ok) throw new Error(result.error.message);
}
