import { appendEvent } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const app = createApp({ db, changeStreamIntervalMs: 10 });
  return { db, project, app };
}

/** Lee del stream hasta que aparezca `needle` o se acabe el tiempo. */
async function readUntil(body: ReadableStream<Uint8Array>, needle: string, ms = 2000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (!text.includes(needle) && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
      ]);
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

describe("GET /api/stream", () => {
  it("emite un change con las tareas que tuvieron eventos nuevos", async () => {
    const { db, project, app } = setup();
    const before = insertTask(db, project.id);
    appendEvent(db, { taskId: before.id, type: "viejo", actor: "human" });
    const abort = new AbortController();
    const res = await app.request("/api/stream", { signal: abort.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const task = insertTask(db, project.id);
    const event = appendEvent(db, { taskId: task.id, type: "nuevo", actor: "system" });
    const text = await readUntil(res.body as ReadableStream<Uint8Array>, "event: change");
    abort.abort();

    expect(text).toContain("event: change");
    expect(text).toContain(`id: ${event.id}`);
    expect(text).toContain(JSON.stringify({ taskIds: [task.id] }));
    expect(text).not.toContain(before.id);
  });

  it("al reconectar con Last-Event-ID manda lo que se perdió", async () => {
    const { db, project, app } = setup();
    const task = insertTask(db, project.id);
    const seen = appendEvent(db, { taskId: task.id, type: "visto", actor: "human" });
    const missed = appendEvent(db, { taskId: task.id, type: "perdido", actor: "system" });
    const abort = new AbortController();
    const res = await app.request("/api/stream", {
      signal: abort.signal,
      headers: { "Last-Event-ID": String(seen.id) },
    });
    const text = await readUntil(res.body as ReadableStream<Uint8Array>, "event: change");
    abort.abort();
    expect(text).toContain(`id: ${missed.id}`);
  });
});
