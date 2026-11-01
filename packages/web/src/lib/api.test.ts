import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { ApiError, api } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());

function seeded() {
  const fake = new FakeApi();
  vi.stubGlobal("fetch", fake.fetch);
  const task = fake.addTask(fake.addProject().id);
  return { fake, task };
}

describe("api.focusRun", () => {
  it("pide POST /api/runs/:runId/focus y el FakeApi registra el agente enfocado", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "implement");
    await api.focusRun(run.id);
    expect(fake.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/runs/${run.id}/focus`,
    });
    expect(fake.focused).toEqual([run.herdrName]);
  });

  it("el FakeApi solo enfoca con POST, como el servidor: un GET responde 404 y no enfoca", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "implement");
    const response = await fake.fetch(`/api/runs/${run.id}/focus`);
    expect(response.status).toBe(404);
    expect(fake.focused).toEqual([]);
  });

  it("un Run que no existe falla con 404 not_found", async () => {
    seeded();
    await expect(api.focusRun("no-existe")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("un Run sin pane o sin nombre de agente falla con 409 no_pane", async () => {
    const { fake, task } = seeded();
    const noPane = fake.startRun(task.id, "refine");
    noPane.herdrPane = null;
    const noName = fake.startRun(task.id, "implement");
    noName.herdrName = null;
    for (const run of [noPane, noName]) {
      await expect(api.focusRun(run.id)).rejects.toMatchObject({ status: 409, code: "no_pane" });
    }
    expect(fake.focused).toEqual([]);
  });

  it("propaga el error de herdr que fije el FakeApi", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "implement");
    fake.focusError = { status: 502, error: "herdr_error", message: "herdr no responde" };
    const error = await api.focusRun(run.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: "herdr_error", message: "herdr no responde" });
    expect(fake.focused).toEqual([]);
  });
});
