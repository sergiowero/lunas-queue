import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appendEvent, listEvents } from "./event-log.ts";
import { events } from "./schema.ts";
import { insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

const APPEND_ONLY = /append-only/;

describe("Event log", () => {
  it("appendEvent stores type, actor and payload; listEvents returns them in order", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const other = insertTask(db, insertProject(db).id);
    const first = appendEvent(db, {
      taskId: t.id,
      type: "task.created",
      actor: "human",
      payload: { goal: "x" },
    });
    appendEvent(db, { taskId: other.id, type: "task.created", actor: "human" });
    const second = appendEvent(db, { taskId: t.id, type: "task.note", actor: "system" });

    expect(first).toMatchObject({ taskId: t.id, type: "task.created", payload: { goal: "x" } });
    expect(first.createdAt).toBeInstanceOf(Date);
    expect(listEvents(db, t.id).map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it("an event cannot be modified", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const e = appendEvent(db, { taskId: t.id, type: "task.created", actor: "human" });
    expect(() => db.update(events).set({ type: "otro" }).where(eq(events.id, e.id)).run()).toThrow(
      APPEND_ONLY,
    );
    expect(() =>
      db.$client.prepare("update events set payload = '{}' where id = ?").run(e.id),
    ).toThrow(APPEND_ONLY);
    expect(listEvents(db, t.id)[0]?.type).toBe("task.created");
  });

  it("an event cannot be deleted", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const e = appendEvent(db, { taskId: t.id, type: "task.created", actor: "human" });
    expect(() => db.delete(events).where(eq(events.id, e.id)).run()).toThrow(APPEND_ONLY);
    expect(() => db.$client.prepare("delete from events").run()).toThrow(APPEND_ONLY);
    expect(listEvents(db, t.id)).toHaveLength(1);
  });
});
