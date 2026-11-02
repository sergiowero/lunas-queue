import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

function seeded() {
  const fake = new FakeApi();
  const project = fake.addProject({ name: "lunas-queue" });
  // Numbers far from 1 so they do not coincide with positions or priorities.
  const base = fake.addTask(project.id, { intent: "Esquema base", number: 41 });
  const task = fake.addTask(project.id, { intent: "Login con email", number: 42 });
  fake.edges.push({ taskId: task.id, dependsOnId: base.id });
  return { fake, project, base, task };
}

/** The task's #N goes next to its intent: the element containing it also has the intent. */
function nextToIntent(scope: ReturnType<typeof within>, number: number, intent: string) {
  const label = scope.getByText(`#${number}`);
  expect(label.parentElement?.textContent).toContain(intent);
}

describe("task number in the views", () => {
  it("board: each card shows the #N next to the intent", async () => {
    const { fake, project } = seeded();
    renderApp(`/projects/${project.id}`, fake);
    const draft = within(await screen.findByRole("region", { name: "Draft" }));
    await draft.findByRole("link", { name: "Login con email" });
    nextToIntent(draft, 42, "Login con email");
    nextToIntent(draft, 41, "Esquema base");
  });

  it("queue: each row shows the #N next to the intent", async () => {
    const { fake, task } = seeded();
    fake.queue = [
      {
        task,
        ready: true,
        score: 1,
        effectivePriority: 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
        },
      },
    ];
    renderApp("/queue", fake);
    const table = within(await screen.findByRole("table"));
    await table.findByRole("link", { name: "Login con email" });
    nextToIntent(table, 42, "Login con email");
  });

  it("in progress: an in_progress task shows the #N next to the intent and the link keeps its name", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "in_progress", "queued");
    renderApp("/in-progress", fake);
    const table = within(await screen.findByRole("table"));
    const link = await table.findByRole("link", { name: "Login con email" });
    expect(link.getAttribute("href")).toBe(`/tasks/${task.id}`);
    nextToIntent(table, 42, "Login con email");
  });

  it("in progress: a task with running sub-state in another state shows the #N next to the intent", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "verification", "running");
    renderApp("/in-progress", fake);
    const table = within(await screen.findByRole("table"));
    await table.findByRole("link", { name: "Login con email" });
    nextToIntent(table, 42, "Login con email");
  });

  it("completed: a completed task shows the #N next to the intent and the link keeps its name", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "completed", null);
    renderApp("/completed", fake);
    const table = within(await screen.findByRole("table"));
    const link = await table.findByRole("link", { name: "Login con email" });
    expect(link.getAttribute("href")).toBe(`/tasks/${task.id}`);
    nextToIntent(table, 42, "Login con email");
  });

  it("inbox: each pending item shows the #N of its task", async () => {
    const { fake, task } = seeded();
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    renderApp("/inbox", fake);
    const specs = within(await screen.findByRole("region", { name: "Specs por aprobar" }));
    await specs.findByRole("link", { name: "Login con email" });
    nextToIntent(specs, 42, "Login con email");
  });

  it("detail: the header and the dependencies show the #N", async () => {
    const { fake, task } = seeded();
    renderApp(`/tasks/${task.id}`, fake);
    await screen.findByRole("heading", { name: "Login con email" });
    expect(screen.getByText("#42")).toBeTruthy();
    const deps = within(await screen.findByRole("region", { name: "Dependencias" }));
    await deps.findByRole("link", { name: "Esquema base" });
    nextToIntent(deps, 41, "Esquema base");
  });

  it("detail: the selector for adding a dependency shows the #N of each candidate", async () => {
    const { fake, project, task } = seeded();
    fake.addTask(project.id, { intent: "Endpoint de login", number: 43 });
    renderApp(`/tasks/${task.id}`, fake);
    const deps = within(await screen.findByRole("region", { name: "Dependencias" }));
    const select = await deps.findByLabelText("Agregar dependencia");
    const option = within(select).getByRole("option", { name: /Endpoint de login/ });
    expect(option.textContent).toContain("#43");
  });
});
