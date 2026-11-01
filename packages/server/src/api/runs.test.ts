import { HerdrError } from "@lunasq/adapters";
import { RunRepository } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";

const missing = "00000000-0000-4000-8000-000000000999";

function setup(focus?: (name: string) => Promise<unknown>) {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id);
  const withPane = insertRun(db, task.id, { herdrPane: "w1:p2", herdrName: "t1-implement-1" });
  const app = createApp({ db, ...(focus ? { focus } : {}) });
  const post = (runId: string) => app.request(`/api/runs/${runId}/focus`, { method: "POST" });
  return { db, project, task, withPane, post };
}

describe("POST /api/runs/:runId/focus", () => {
  it("enfoca en herdr el agente del Run y responde 204", async () => {
    const focus = vi.fn(async () => undefined);
    const { post, withPane } = setup(focus);
    const res = await post(withPane.id);
    expect(res.status).toBe(204);
    expect(focus).toHaveBeenCalledExactlyOnceWith("t1-implement-1");
  });

  it("un Run que no existe responde 404 not_found sin tocar herdr", async () => {
    const focus = vi.fn(async () => undefined);
    const { post } = setup(focus);
    const res = await post(missing);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    expect(focus).not.toHaveBeenCalled();
  });

  it.each([
    ["sin herdrPane", { herdrPane: null, herdrName: "t1-implement-1" }],
    ["sin herdrName", { herdrPane: "w1:p2", herdrName: null }],
  ])("un Run %s responde 409 no_pane sin tocar herdr", async (_, overrides) => {
    const focus = vi.fn(async () => undefined);
    const { post, db, project } = setup(focus);
    const run = insertRun(db, insertTask(db, project.id).id, overrides);
    const res = await post(run.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_pane" });
    expect(focus).not.toHaveBeenCalled();
  });

  it("si herdr ya no tiene el agente responde 409 agent_gone y nombra al agente", async () => {
    const { post, withPane } = setup(async () => {
      throw new HerdrError("agent_not_found", "agent target t1-implement-1 not found");
    });
    const res = await post(withPane.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("agent_gone");
    expect(body.message).toContain("t1-implement-1");
  });

  it("otro error de herdr responde 502 herdr_error con el mensaje", async () => {
    const { post, withPane } = setup(async () => {
      throw new HerdrError("server_unavailable", "herdr no responde");
    });
    const res = await post(withPane.id);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "herdr_error",
      message: expect.stringContaining("herdr no responde"),
    });
  });

  it("sin herdr en el servidor responde 503 focus_unavailable", async () => {
    const { post, withPane } = setup();
    const res = await post(withPane.id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "focus_unavailable" });
  });

  it("enfocar no modifica el Run", async () => {
    const { post, withPane, db } = setup(async () => undefined);
    const before = new RunRepository(db).get(withPane.id);
    await post(withPane.id);
    expect(new RunRepository(db).get(withPane.id)).toEqual(before);
  });
});
