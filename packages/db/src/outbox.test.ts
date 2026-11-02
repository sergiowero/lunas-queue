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

/** Makes any insert into outbox fail, like a crash halfway through the transaction. */
const breakOutbox = (db: LunasqDatabase) =>
  db.$client.exec(
    "create trigger outbox_broken before insert on outbox begin select raise(abort, 'outbox caído'); end",
  );

describe("Outbox: enqueueing", () => {
  it("appendEvent with publish leaves the event and its pending row in the same write", () => {
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

  it("appendEvent without publish does not enqueue", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    appendEvent(db, { taskId: t.id, type: "task.note", actor: "system" });
    expect(outboxRows(db)).toEqual([]);
  });

  it("enqueuing the same event twice leaves a single row", () => {
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

  it("if the outbox fails, appendEvent leaves no event", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    breakOutbox(db);
    expect(() =>
      appendEvent(db, { taskId: t.id, type: "task.created", actor: "human" }, { publish: true }),
    ).toThrow(/outbox caído/);
    expect(listEvents(db, t.id)).toEqual([]);
  });

  it("transitionTask enqueues its task.transitioned event", () => {
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

  it("if the outbox fails, the transition is rolled back completely: neither state nor event", () => {
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

  it("a rejected transition enqueues nothing", () => {
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

describe("Outbox: reading and marks", () => {
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

  it("listPendingOutbox returns valid messages in write order, with a limit", () => {
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

  it("markOutboxPublished removes the message from pending and only marks once", () => {
    const db = migratedDatabase();
    seed(db, 2);
    const [first, second] = listPendingOutbox(db);
    if (!first || !second) throw new Error("pending messages are missing");

    expect(markOutboxPublished(db, first.message.id)).toBe(true);
    expect(markOutboxPublished(db, first.message.id)).toBe(false);
    expect(listPendingOutbox(db).map((p) => p.message.id)).toEqual([second.message.id]);
    expect(outboxRows(db)[0]?.publishedAt).toBeInstanceOf(Date);
  });

  it("recordOutboxFailure adds attempts without removing the message from pending", () => {
    const db = migratedDatabase();
    seed(db, 1);
    const id = listPendingOutbox(db)[0]?.message.id ?? 0;
    expect(recordOutboxFailure(db, id)).toBe(1);
    expect(recordOutboxFailure(db, id)).toBe(2);
    expect(listPendingOutbox(db)[0]).toMatchObject({ attempts: 2 });
  });
});
