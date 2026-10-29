import { OutboxMessage, TASK_TRANSITIONED } from "@lunasq/schemas";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent, listEvents } from "./event-log.ts";
import {
  enqueueOutbox,
  listPendingOutbox,
  markOutboxPublished,
  recordOutboxFailure,
} from "./outbox.ts";
import { outbox, tasks } from "./schema.ts";
import { transitionTask } from "./task-transitions.ts";
import { insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

const outboxRows = (db: LunasqDatabase) => db.select().from(outbox).orderBy(outbox.id).all();

/** Hace fallar cualquier insert en outbox, como una caída a mitad de la transacción. */
const breakOutbox = (db: LunasqDatabase) =>
  db.$client.exec(
    "create trigger outbox_broken before insert on outbox begin select raise(abort, 'outbox caído'); end",
  );

describe("Outbox: encolado", () => {
  it("appendEvent con publish deja el evento y su fila pendiente en la misma escritura", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const e = appendEvent(
      db,
      { taskId: t.id, type: "task.created", actor: "human" },
      { publish: true },
    );

    expect(outboxRows(db)).toEqual([
      expect.objectContaining({
        eventId: e.id,
        topic: "task.created",
        publishedAt: null,
        attempts: 0,
      }),
    ]);
  });

  it("appendEvent sin publish no encola", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    appendEvent(db, { taskId: t.id, type: "task.note", actor: "system" });
    expect(outboxRows(db)).toEqual([]);
  });

  it("encolar dos veces el mismo evento deja una sola fila", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const e = appendEvent(
      db,
      { taskId: t.id, type: "task.created", actor: "human" },
      { publish: true },
    );
    enqueueOutbox(db, e);
    enqueueOutbox(db, e);
    expect(outboxRows(db)).toHaveLength(1);
  });

  it("si el outbox falla, appendEvent no deja el evento", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    breakOutbox(db);
    expect(() =>
      appendEvent(db, { taskId: t.id, type: "task.created", actor: "human" }, { publish: true }),
    ).toThrow(/outbox caído/);
    expect(listEvents(db, t.id)).toEqual([]);
  });

  it("transitionTask encola su evento task.transitioned", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const result = transitionTask(db, {
      taskId: t.id,
      actor: "system",
      command: { type: "dispatch" },
    });
    if (!result.ok) throw new Error(result.error.code);

    expect(outboxRows(db)).toEqual([
      expect.objectContaining({
        eventId: result.event.id,
        topic: TASK_TRANSITIONED,
        publishedAt: null,
      }),
    ]);
  });

  it("si el outbox falla, la transición se revierte completa: ni estado ni evento", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    breakOutbox(db);
    expect(() =>
      transitionTask(db, { taskId: t.id, actor: "system", command: { type: "dispatch" } }),
    ).toThrow(/outbox caído/);
    expect(db.select().from(tasks).where(eq(tasks.id, t.id)).get()).toMatchObject({
      state: "draft",
      subState: "queued",
    });
    expect(listEvents(db, t.id)).toEqual([]);
  });

  it("una transición rechazada no encola nada", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const result = transitionTask(db, {
      taskId: t.id,
      actor: "human",
      command: { type: "approve", specApproved: true },
    });
    expect(result.ok).toBe(false);
    expect(outboxRows(db)).toEqual([]);
  });
});

describe("Outbox: lectura y marcas", () => {
  const seed = (db: LunasqDatabase, n: number) => {
    const t = insertTask(db, insertProject(db).id);
    return Array.from({ length: n }, (_, i) =>
      appendEvent(
        db,
        { taskId: t.id, type: `t.${i}`, actor: "system", payload: { i } },
        { publish: true },
      ),
    );
  };

  it("listPendingOutbox devuelve mensajes válidos en orden de escritura, con límite", () => {
    const db = migratedDatabase();
    const [e0, e1] = seed(db, 3);
    const pending = listPendingOutbox(db, { limit: 2 });

    expect(pending.map((p) => p.message.eventId)).toEqual([e0?.id, e1?.id]);
    const first = pending[0];
    expect(OutboxMessage.parse(first?.message)).toEqual(first?.message);
    expect(first).toMatchObject({
      attempts: 0,
      message: { topic: "t.0", taskId: e0?.taskId, actor: "system", payload: { i: 0 } },
    });
  });

  it("markOutboxPublished saca el mensaje de pendientes y solo marca una vez", () => {
    const db = migratedDatabase();
    seed(db, 2);
    const [first, second] = listPendingOutbox(db);
    if (!first || !second) throw new Error("faltan pendientes");

    expect(markOutboxPublished(db, first.message.id)).toBe(true);
    expect(markOutboxPublished(db, first.message.id)).toBe(false);
    expect(listPendingOutbox(db).map((p) => p.message.id)).toEqual([second.message.id]);
    expect(outboxRows(db)[0]?.publishedAt).toBeInstanceOf(Date);
  });

  it("recordOutboxFailure suma intentos sin sacar el mensaje de pendientes", () => {
    const db = migratedDatabase();
    seed(db, 1);
    const id = listPendingOutbox(db)[0]?.message.id ?? 0;
    expect(recordOutboxFailure(db, id)).toBe(1);
    expect(recordOutboxFailure(db, id)).toBe(2);
    expect(listPendingOutbox(db)[0]).toMatchObject({ attempts: 2 });
  });
});
