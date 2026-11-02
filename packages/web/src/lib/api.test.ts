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
  it("requests POST /api/runs/:runId/focus and the FakeApi records the focused agent", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "implement");
    await api.focusRun(run.id);
    expect(fake.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/runs/${run.id}/focus`,
    });
    expect(fake.focused).toEqual([run.herdrName]);
  });

  it("the FakeApi only focuses with POST, like the server: a GET answers 404 and does not focus", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "implement");
    const response = await fake.fetch(`/api/runs/${run.id}/focus`);
    expect(response.status).toBe(404);
    expect(fake.focused).toEqual([]);
  });

  it("a Run that does not exist fails with 404 not_found", async () => {
    seeded();
    await expect(api.focusRun("no-existe")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("a Run without a pane or agent name fails with 409 no_pane", async () => {
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

  it("propagates the herdr error set by the FakeApi", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "implement");
    fake.focusError = { status: 502, error: "herdr_error", message: "herdr no responde" };
    const error = await api.focusRun(run.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: "herdr_error", message: "herdr no responde" });
    expect(fake.focused).toEqual([]);
  });
});

describe("api.pauseTask and resumeTask", () => {
  it("pauseTask requests POST /api/tasks/:id/pause and returns the paused task", async () => {
    const { fake, task } = seeded();
    const paused = await api.pauseTask(task.id);
    expect(fake.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/tasks/${task.id}/pause`,
    });
    expect(paused).toMatchObject({ id: task.id, state: "paused", subState: null });
  });

  it("resumeTask returns the paused task to its previous state", async () => {
    const { task } = seeded();
    await api.pauseTask(task.id);
    expect(await api.resumeTask(task.id)).toMatchObject({ state: "draft", subState: "queued" });
  });

  it("pausing a task that cannot be paused fails with 409 invalid_transition", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "completed", null);
    await expect(api.pauseTask(task.id)).rejects.toMatchObject({
      status: 409,
      code: "invalid_transition",
    });
  });
});
