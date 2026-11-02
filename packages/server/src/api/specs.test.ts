import { SpecRepository } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import type { SpecContent } from "@lunasq/schemas";
import { specContentExample } from "@lunasq/schemas/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const missing = "00000000-0000-4000-8000-000000000999";

type Body = Record<string, unknown>;

function revised(): SpecContent {
  const content = specContentExample();
  content.requirements.push("El cliente recibe un correo al cancelar");
  return content;
}

// A task in refined with version 1 of its spec, delivered by the refiner.
function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id, { state: "draft", subState: "running" });
  const submitted = new SpecRepository(db).submit(task.id, specContentExample());
  if (!submitted.ok) throw new Error(submitted.error.message);
  const app = createApp({ db });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const base = `/api/tasks/${task.id}/specs`;
  return { db, task, send, base };
}

describe("GET /api/tasks/:id/specs", () => {
  it("lists the versions and reads one by number", async () => {
    const { send, base, task } = setup();
    const list = await send("GET", base);
    expect(list.status).toBe(200);
    const versions = (await list.json()) as Body[];
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ taskId: task.id, version: 1, approval: "pending" });

    const one = await send("GET", `${base}/1`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ version: 1, content: specContentExample() });
  });

  it("404 if the task or the version do not exist; 400 if the version is not a positive integer", async () => {
    const { send, base } = setup();
    expect((await send("GET", `/api/tasks/${missing}/specs`)).status).toBe(404);
    expect((await send("GET", `${base}/2`)).status).toBe(404);
    const bad = await send("GET", `${base}/0`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_input" });
  });
});

describe("POST /api/tasks/:id/specs/:version/approve", () => {
  it("approves the exact version and the task moves to in_progress", async () => {
    const { send, base } = setup();
    const res = await send("POST", `${base}/1/approve`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      spec: { version: 1, approval: "approved", approvedBy: "human" },
      task: { state: "in_progress", subState: "queued" },
    });
  });

  it("409 when repeating or with a superseded version; 404 if it does not exist", async () => {
    const { send, base } = setup();
    expect((await send("POST", `${base}/1/approve`)).status).toBe(200);
    const again = await send("POST", `${base}/1/approve`);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "spec_not_pending" });
    expect((await send("POST", `${base}/5/approve`)).status).toBe(404);
    expect((await send("POST", `/api/tasks/${missing}/specs/1/approve`)).status).toBe(404);
  });

  it("409 stale_version when approving a version that is no longer the latest", async () => {
    const { send, base } = setup();
    await send("POST", `${base}/1/edit-and-approve`, { content: revised() });
    const res = await send("POST", `${base}/1/approve`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "stale_version" });
  });
});

describe("POST /api/tasks/:id/specs/:version/request-changes", () => {
  it("saves the comments and sends the task back to draft", async () => {
    const { send, base } = setup();
    const res = await send("POST", `${base}/1/request-changes`, {
      comments: "Falta el caso de pedido enviado",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      spec: {
        version: 1,
        approval: "changes_requested",
        reviewComments: "Falta el caso de pedido enviado",
      },
      task: { state: "draft", subState: "queued" },
    });
  });

  it("409 if the version was already decided or was superseded", async () => {
    const { send, base } = setup();
    const comments = { comments: "otra ronda" };
    expect((await send("POST", `${base}/1/request-changes`, comments)).status).toBe(200);
    const again = await send("POST", `${base}/1/request-changes`, comments);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "spec_not_pending" });
  });

  it("400 without comments or with invalid JSON", async () => {
    const { send, base } = setup();
    expect((await send("POST", `${base}/1/request-changes`, { comments: " " })).status).toBe(400);
    expect((await send("POST", `${base}/1/request-changes`, "{")).status).toBe(400);
    expect((await send("GET", `${base}/1`)).status).toBe(200);
  });
});

describe("POST /api/tasks/:id/specs/:version/edit-and-approve", () => {
  it("creates the next version with human author, approved", async () => {
    const { send, base } = setup();
    const res = await send("POST", `${base}/1/edit-and-approve`, { content: revised() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      spec: { version: 2, createdBy: "human", approval: "approved", content: revised() },
      task: { state: "in_progress" },
    });
  });

  it("409 when retrying: the base version was already superseded by the edited one", async () => {
    const { send, base } = setup();
    const body = { content: revised() };
    expect((await send("POST", `${base}/1/edit-and-approve`, body)).status).toBe(200);
    const again = await send("POST", `${base}/1/edit-and-approve`, body);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "stale_version" });
    const versions = (await (await send("GET", base)).json()) as Body[];
    expect(versions).toHaveLength(2);
  });

  it("400 with incomplete content", async () => {
    const { send, base } = setup();
    const res = await send("POST", `${base}/1/edit-and-approve`, {
      content: { ...revised(), criteria: [] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
  });
});

describe("GET /api/tasks/:id/specs/:version/diff", () => {
  it("compares against the previous one by default or against ?against", async () => {
    const { send, base } = setup();
    await send("POST", `${base}/1/edit-and-approve`, { content: revised() });
    const res = await send("GET", `${base}/2/diff`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as {
      from: number;
      to: number;
      identical: boolean;
      changes: { requirements: { added: string[] } };
    };
    expect(diff).toMatchObject({ from: 1, to: 2, identical: false });
    expect(diff.changes.requirements.added).toEqual(["El cliente recibe un correo al cancelar"]);
    expect(await (await send("GET", `${base}/2/diff?against=2`)).json()).toMatchObject({
      identical: true,
    });
  });

  it("404 if either version does not exist; 400 with invalid ?against", async () => {
    const { send, base } = setup();
    expect((await send("GET", `${base}/1/diff?against=4`)).status).toBe(404);
    expect((await send("GET", `${base}/1/diff?against=x`)).status).toBe(400);
  });
});
