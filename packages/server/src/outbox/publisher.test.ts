import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendEvent,
  type LunasqDatabase,
  listPendingOutbox,
  migrateDatabase,
  openDatabase,
  transitionTask,
} from "@lunasq/db";
import {
  freshDatabase,
  insertProject,
  insertTask,
  migratedDatabase,
} from "@lunasq/db/test-helpers";
import { type OutboxMessage, TASK_TRANSITIONED, TaskTransitionedPayload } from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboxPublisher } from "./publisher.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const publishers: OutboxPublisher[] = [];
afterEach(async () => {
  await Promise.all(publishers.splice(0).map((p) => p.stop()));
  vi.useRealTimers();
});

const publisher = (
  db: LunasqDatabase,
  opts: Partial<ConstructorParameters<typeof OutboxPublisher>[0]> = {},
) => {
  const p = new OutboxPublisher({ db, onError: () => {}, ...opts });
  publishers.push(p);
  return p;
};

const dispatch = (db: LunasqDatabase, taskId: string) => {
  const result = transitionTask(db, { taskId, actor: "system", command: { type: "dispatch" } });
  if (!result.ok) throw new Error(result.error.code);
  return result;
};

const seed = (db: LunasqDatabase, n: number) => {
  const t = insertTask(db, insertProject(db).id);
  return Array.from({ length: n }, (_, i) =>
    appendEvent(
      db,
      { taskId: t.id, type: "t.test", actor: "system", payload: { i } },
      { publish: true },
    ),
  );
};

describe("OutboxPublisher: no loss on crashes", () => {
  it("a process that dies after the commit without publishing: the next publisher delivers the event", () => {
    const { db, file } = freshDatabase();
    migrateDatabase(db);
    const t = insertTask(db, insertProject(db).id);

    const child = spawnSync(process.execPath, [fixture("transition-then-crash.ts"), file, t.id], {
      encoding: "utf8",
    });
    expect(child.stderr).toBe("");
    expect(child.signal).toBe("SIGKILL");

    const received: OutboxMessage[] = [];
    const p = publisher(db);
    p.subscribe(TASK_TRANSITIONED, (m) => {
      received.push(m);
    });
    return p.start().then(() => {
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ taskId: t.id, topic: TASK_TRANSITIONED });
      expect(TaskTransitionedPayload.parse(received[0]?.payload)).toMatchObject({
        command: "dispatch",
        to: { state: "draft", subState: "running" },
      });
      expect(listPendingOutbox(db)).toEqual([]);
    });
  });

  it("commit without publishing and reopening the database: start delivers what is pending", async () => {
    const { db, file } = freshDatabase();
    migrateDatabase(db);
    const t = insertTask(db, insertProject(db).id);
    const { event } = dispatch(db, t.id);

    const reopened = openDatabase(file);
    try {
      const received: number[] = [];
      const p = publisher(reopened);
      p.subscribe("*", (m) => {
        received.push(m.eventId);
      });
      await p.start();
      expect(received).toEqual([event.id]);
    } finally {
      await publishers.pop()?.stop();
      reopened.$client.close();
    }
  });

  it("crash after delivering and before marking: the message is redelivered (at-least-once)", async () => {
    const { db, file } = freshDatabase();
    migrateDatabase(db);
    const [e] = seed(db, 1);

    const child = spawnSync(process.execPath, [fixture("deliver-then-crash.ts"), file], {
      encoding: "utf8",
    });
    expect(child.stderr).toBe("");
    expect(child.signal).toBe("SIGKILL");
    expect(listPendingOutbox(db)).toMatchObject([{ attempts: 0, message: { eventId: e?.id } }]);

    const received: number[] = [];
    const p = publisher(db);
    p.subscribe("*", (m) => {
      received.push(m.eventId);
    });
    await p.drain();
    expect(received).toEqual([e?.id]);
  });
});

describe("OutboxPublisher: delivery", () => {
  it("delivers in write order to the subscribers of its topic and to those of '*'", async () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    appendEvent(db, { taskId: t.id, type: "a", actor: "system" }, { publish: true });
    appendEvent(db, { taskId: t.id, type: "b", actor: "system" }, { publish: true });
    appendEvent(db, { taskId: t.id, type: "a", actor: "system" }, { publish: true });

    const onlyA: string[] = [];
    const all: string[] = [];
    const p = publisher(db);
    p.subscribe("a", (m) => {
      onlyA.push(m.topic);
    });
    p.subscribe("*", (m) => {
      all.push(m.topic);
    });
    expect(await p.drain()).toBe(3);
    expect(onlyA).toEqual(["a", "a"]);
    expect(all).toEqual(["a", "b", "a"]);
    expect(await p.drain()).toBe(0);
  });

  it("waits for async handlers before marking", async () => {
    const db = migratedDatabase();
    seed(db, 1);
    let pendingDuringHandler = -1;
    const p = publisher(db);
    p.subscribe("*", async () => {
      await new Promise((r) => setTimeout(r, 5));
      pendingDuringHandler = listPendingOutbox(db).length;
    });
    await p.drain();
    expect(pendingDuringHandler).toBe(1);
    expect(listPendingOutbox(db)).toEqual([]);
  });

  it("a handler that fails stops the drain, adds attempts, reports and retries in order", async () => {
    const db = migratedDatabase();
    const [e0, e1] = seed(db, 2);
    const errors: { attempts: number; eventId: number }[] = [];
    let fail = true;
    const received: number[] = [];
    const p = publisher(db, {
      onError: (_error, failed) => {
        if (failed) errors.push({ attempts: failed.attempts, eventId: failed.message.eventId });
      },
    });
    p.subscribe("*", (m) => {
      if (fail) throw new Error("scheduler caído");
      received.push(m.eventId);
    });

    expect(await p.drain()).toBe(0);
    expect(await p.drain()).toBe(0);
    expect(errors).toEqual([
      { attempts: 1, eventId: e0?.id },
      { attempts: 2, eventId: e0?.id },
    ]);
    expect(listPendingOutbox(db)).toHaveLength(2);

    fail = false;
    expect(await p.drain()).toBe(2);
    expect(received).toEqual([e0?.id, e1?.id]);
  });

  it("concurrent drains do not deliver twice", async () => {
    const db = migratedDatabase();
    seed(db, 3);
    const received: number[] = [];
    const p = publisher(db);
    p.subscribe("*", async (m) => {
      await new Promise((r) => setTimeout(r, 1));
      received.push(m.eventId);
    });
    await Promise.all([p.drain(), p.drain(), p.drain()]);
    expect(received).toHaveLength(3);
    expect(new Set(received).size).toBe(3);
  });

  it("what is enqueued during a drain is delivered in that same drain when wake is called", async () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    seed(db, 1);
    const received: string[] = [];
    const p = publisher(db);
    p.subscribe("*", (m) => {
      received.push(m.topic);
      if (m.topic === "t.test") {
        appendEvent(db, { taskId: t.id, type: "nuevo", actor: "system" }, { publish: true });
        p.wake();
      }
    });
    await p.drain();
    expect(received).toEqual(["t.test", "nuevo"]);
  });

  it("processes batches until the queue is empty", async () => {
    const db = migratedDatabase();
    seed(db, 5);
    const p = publisher(db, { batchSize: 2 });
    let count = 0;
    p.subscribe("*", () => {
      count += 1;
    });
    expect(await p.drain()).toBe(5);
    expect(count).toBe(5);
  });

  it("a message whose topic has no subscribers is marked published", async () => {
    const db = migratedDatabase();
    seed(db, 1);
    const p = publisher(db);
    p.subscribe("otro.topic", () => {});
    expect(await p.drain()).toBe(1);
    expect(listPendingOutbox(db)).toEqual([]);
  });

  it("without any subscriber it marks nothing: an early start does not lose what is pending", async () => {
    const db = migratedDatabase();
    seed(db, 1);
    const p = publisher(db, { pollIntervalMs: 60_000 });
    await p.start();
    expect(listPendingOutbox(db)).toHaveLength(1);

    const handler = vi.fn();
    p.subscribe("*", handler);
    p.wake();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  it("unsubscribing stops delivery to that handler", async () => {
    const db = migratedDatabase();
    seed(db, 1);
    const handler = vi.fn();
    const p = publisher(db);
    const unsubscribe = p.subscribe("*", handler);
    unsubscribe();
    await p.drain();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("OutboxPublisher: lifecycle", () => {
  it("after start, wake publishes what was just confirmed", async () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const received: number[] = [];
    const p = publisher(db, { pollIntervalMs: 60_000 });
    p.subscribe(TASK_TRANSITIONED, (m) => {
      received.push(m.eventId);
    });
    await p.start();
    const { event } = dispatch(db, t.id);
    p.wake();
    await vi.waitFor(() => expect(received).toEqual([event.id]));
  });

  it("the periodic poll delivers what nobody woke, and stop halts it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const db = migratedDatabase();
    const p = publisher(db, { pollIntervalMs: 1000 });
    const handler = vi.fn();
    p.subscribe("*", handler);
    await p.start();

    seed(db, 1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    await p.stop();
    seed(db, 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stop waits for the drain in progress", async () => {
    const db = migratedDatabase();
    seed(db, 1);
    let finished = false;
    let started: () => void = () => {};
    const handlerStarted = new Promise<void>((r) => {
      started = r;
    });
    const p = publisher(db);
    p.subscribe("*", async () => {
      started();
      await new Promise((r) => setTimeout(r, 10));
      finished = true;
    });
    const draining = p.drain();
    await handlerStarted;
    await p.stop();
    expect(finished).toBe(true);
    expect(listPendingOutbox(db)).toEqual([]);
    await draining;
  });

  it("start right after stop, with a drain exiting, delivers what is pending without waiting for the poll", async () => {
    const db = migratedDatabase();
    seed(db, 1);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const received: number[] = [];
    const p = publisher(db, { pollIntervalMs: 60_000 });
    p.subscribe("*", async (m) => {
      if (received.length === 0) await gate;
      received.push(m.eventId);
    });
    const draining = p.drain();
    const stopping = p.stop();
    const [late] = seed(db, 1);
    const starting = p.start();
    release();
    await Promise.all([draining, stopping, starting]);
    await vi.waitFor(() => expect(received).toContain(late?.id));
    expect(received).toHaveLength(2);
  });

  it("an error in onError does not break the publisher", async () => {
    const db = migratedDatabase();
    seed(db, 1);
    const p = publisher(db, {
      onError: () => {
        throw new Error("logger roto");
      },
    });
    p.subscribe("*", () => {
      throw new Error("handler");
    });
    await expect(p.drain()).resolves.toBe(0);
  });
});
