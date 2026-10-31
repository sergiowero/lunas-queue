import {
  DELIVERY_CONFLICT,
  TASK_PR_OPENED,
  TASK_PR_STATE_CHANGED,
  TaskPrOpenedPayload,
  TaskPrStateChangedPayload,
} from "@lunasq/schemas";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { listEvents } from "./event-log.ts";
import { listPendingOutbox } from "./outbox.ts";
import { tasks } from "./schema.ts";
import { TaskPrRepository } from "./task-prs.ts";
import { insertProject, insertRun, insertTask, migratedDatabase } from "./test-helpers.ts";

const url = "https://github.com/sergiowero/demo/pull/1";
const otherUrl = "https://github.com/sergiowero/demo/pull/2";
const mergedAt = new Date("2026-10-29T17:54:13.000Z");

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const repo = new TaskPrRepository(db);
  const task = insertTask(db, project.id, { state: "completed", subState: null });
  const row = () => db.select().from(tasks).where(eq(tasks.id, task.id)).get();
  const prEvents = () => listEvents(db, task.id).filter((e) => e.type.startsWith("task.pr_"));
  return { db, project, repo, task, row, prEvents };
}

describe("TaskPrRepository.recordPrOpened", () => {
  it("guarda URL y estado open con su evento publicado", () => {
    const { db, repo, task, row, prEvents } = setup();
    expect(repo.recordPrOpened(task.id, url)).toBe(true);
    expect(row()).toMatchObject({ prUrl: url, prState: "open" });
    const [event] = prEvents();
    expect(event).toMatchObject({ type: TASK_PR_OPENED, actor: "system" });
    expect(TaskPrOpenedPayload.parse(event?.payload)).toEqual({ url, previousUrl: null });
    expect(listPendingOutbox(db).map((m) => m.message.topic)).toContain(TASK_PR_OPENED);
  });

  it("repetirlo no duplica el evento", () => {
    const { repo, task, prEvents } = setup();
    repo.recordPrOpened(task.id, url);
    expect(repo.recordPrOpened(task.id, url)).toBe(false);
    expect(prEvents()).toHaveLength(1);
  });

  it("un PR nuevo tras un cierre sin merge reemplaza al anterior", () => {
    const { repo, task, row, prEvents } = setup();
    repo.recordPrOpened(task.id, url);
    repo.recordPrState(task.id, { url, state: "closed", at: null });
    expect(repo.recordPrOpened(task.id, otherUrl)).toBe(true);
    expect(row()).toMatchObject({ prUrl: otherUrl, prState: "open" });
    expect(TaskPrOpenedPayload.parse(prEvents().at(-1)?.payload).previousUrl).toBe(url);
  });

  it("el mismo PR reabierto en GitHub vuelve a open", () => {
    const { repo, task, row } = setup();
    repo.recordPrOpened(task.id, url);
    repo.recordPrState(task.id, { url, state: "closed", at: null });
    expect(repo.recordPrOpened(task.id, url)).toBe(true);
    expect(row()?.prState).toBe("open");
  });

  it("rechaza abrir otro PR si el actual ya se mergeó o si la tarea no existe", () => {
    const { repo, task } = setup();
    repo.recordPrOpened(task.id, url);
    repo.recordPrState(task.id, { url, state: "merged", at: mergedAt });
    expect(() => repo.recordPrOpened(task.id, otherUrl)).toThrow(
      expect.objectContaining({ code: "pr_already_merged" }),
    );
    expect(() => repo.recordPrOpened(crypto.randomUUID(), url)).toThrow(
      expect.objectContaining({ code: "task_not_found" }),
    );
  });

  it("rechaza otro PR mientras el actual sigue abierto", () => {
    const { repo, task, row } = setup();
    repo.recordPrOpened(task.id, url);
    expect(() => repo.recordPrOpened(task.id, otherUrl)).toThrow(
      expect.objectContaining({ code: "pr_already_open" }),
    );
    expect(row()?.prUrl).toBe(url);
  });

  it("rechaza una URL inválida sin escribir nada", () => {
    const { repo, task, row } = setup();
    expect(() => repo.recordPrOpened(task.id, "no-es-url")).toThrow();
    expect(row()?.prUrl).toBeNull();
  });
});

describe("TaskPrRepository.recordPrState", () => {
  it("registra el merge con su hora, una sola vez, y lo publica", () => {
    const { db, repo, task, row, prEvents } = setup();
    repo.recordPrOpened(task.id, url);
    expect(repo.recordPrState(task.id, { url, state: "merged", at: mergedAt })).toBe(true);
    expect(row()?.prState).toBe("merged");
    const event = prEvents().at(-1);
    expect(event).toMatchObject({ type: TASK_PR_STATE_CHANGED, actor: "system" });
    expect(TaskPrStateChangedPayload.parse(event?.payload)).toEqual({
      url,
      from: "open",
      to: "merged",
      at: mergedAt.toISOString(),
    });
    expect(listPendingOutbox(db).map((m) => m.message.topic)).toContain(TASK_PR_STATE_CHANGED);

    expect(repo.recordPrState(task.id, { url, state: "merged", at: mergedAt })).toBe(false);
    expect(prEvents()).toHaveLength(2);
  });

  it("ignora lo que no es un cambio válido del PR actual", () => {
    const { repo, task, row, prEvents } = setup();
    expect(repo.recordPrState(task.id, { url, state: "merged", at: null })).toBe(false);
    repo.recordPrOpened(task.id, url);
    expect(repo.recordPrState(task.id, { url, state: "open", at: null })).toBe(false);
    // Otro PR (p. ej. uno viejo de la tarea) no toca el actual.
    expect(repo.recordPrState(task.id, { url: otherUrl, state: "merged", at: null })).toBe(false);
    repo.recordPrState(task.id, { url, state: "merged", at: mergedAt });
    expect(repo.recordPrState(task.id, { url, state: "closed", at: null })).toBe(false);
    expect(row()?.prState).toBe("merged");
    expect(prEvents().map((e) => e.type)).toEqual([TASK_PR_OPENED, TASK_PR_STATE_CHANGED]);
    expect(repo.recordPrState(crypto.randomUUID(), { url, state: "merged", at: null })).toBe(false);
  });

  it("el merge actualiza updatedAt, que el scheduler usa como readySince", () => {
    const { db, repo, task, row } = setup();
    repo.recordPrOpened(task.id, url);
    const old = new Date("2020-01-01T00:00:00.000Z");
    db.$client.prepare("update tasks set updated_at = ? where id = ?").run(old.getTime(), task.id);
    repo.recordPrState(task.id, { url, state: "merged", at: mergedAt });
    expect(row()?.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });
});

describe("TaskPrRepository.listOpen", () => {
  it("lista solo las tareas con PR abierto", () => {
    const { db, project, repo, task } = setup();
    const merged = insertTask(db, project.id);
    const sinPr = insertTask(db, project.id);
    repo.recordPrOpened(task.id, url);
    repo.recordPrOpened(merged.id, otherUrl);
    repo.recordPrState(merged.id, { url: otherUrl, state: "merged", at: null });
    expect(repo.listOpen()).toEqual([{ taskId: task.id, url }]);
    expect(repo.listOpen().some((p) => p.taskId === sinPr.id)).toBe(false);
  });
});

describe("TaskPrRepository.recordPrConflict", () => {
  it("regresa la tarea completed a in_progress con el conflicto publicado", () => {
    const { db, project, repo, task, row } = setup();
    const verifier = insertRun(db, task.id, { phase: "verify" });
    repo.recordPrOpened(task.id, url);
    expect(repo.recordPrConflict(task.id, url)).toBe(true);
    expect(row()).toMatchObject({ state: "in_progress", subState: "queued", prState: "open" });
    const conflict = listEvents(db, task.id).find((e) => e.type === DELIVERY_CONFLICT);
    expect(conflict?.payload).toEqual({
      runId: verifier.id,
      reason: "pr_conflict",
      baseBranch: project.baseBranch,
      files: [],
      output: null,
    });
    expect(listPendingOutbox(db).map((m) => m.message.topic)).toContain(DELIVERY_CONFLICT);
  });

  it("repetirlo mientras el PR sigue en conflicto no reabre ni duplica el evento", () => {
    const { db, repo, task } = setup();
    insertRun(db, task.id, { phase: "verify" });
    repo.recordPrOpened(task.id, url);
    repo.recordPrConflict(task.id, url);
    expect(repo.recordPrConflict(task.id, url)).toBe(false);
    expect(listEvents(db, task.id).filter((e) => e.type === DELIVERY_CONFLICT)).toHaveLength(1);
  });

  it("no toca una tarea que no está completed, ni un PR que no es el abierto de la tarea", () => {
    const { db, project, repo, task, row } = setup();
    insertRun(db, task.id, { phase: "verify" });
    repo.recordPrOpened(task.id, url);
    expect(repo.recordPrConflict(task.id, otherUrl)).toBe(false);
    repo.recordPrState(task.id, { url, state: "merged", at: mergedAt });
    expect(repo.recordPrConflict(task.id, url)).toBe(false);
    expect(row()?.state).toBe("completed");

    const cancelled = insertTask(db, project.id, { state: "cancelled", subState: null });
    insertRun(db, cancelled.id, { phase: "verify" });
    repo.recordPrOpened(cancelled.id, otherUrl);
    expect(repo.recordPrConflict(cancelled.id, otherUrl)).toBe(false);
  });
});
