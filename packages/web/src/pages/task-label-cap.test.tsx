import { TASK_TITLE_MAX } from "@lunasq/schemas";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

const LONG = `${"Migrar el esquema de usuarios y sus índices a la nueva base de datos".padEnd(90, "x")}`;
const CAPPED = `${LONG.slice(0, TASK_TITLE_MAX - 3)}...`;
const EXACT = "e".repeat(TASK_TITLE_MAX);

type View = {
  name: string;
  path: string;
  seed: (
    fake: FakeApi,
    projectId: string,
    label: { title: string | null; intent: string },
  ) => string;
};

const views: View[] = [
  {
    name: "Queue",
    path: "/queue",
    seed: (fake, projectId, label) => {
      const task = fake.addTask(projectId, label);
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
      return task.id;
    },
  },
  {
    name: "In progress",
    path: "/in-progress",
    seed: (fake, projectId, label) =>
      fake.addTask(projectId, { ...label, state: "in_progress", subState: "running" }).id,
  },
  {
    name: "Completed",
    path: "/completed",
    seed: (fake, projectId, label) =>
      fake.addTask(projectId, { ...label, state: "completed", subState: null }).id,
  },
  {
    name: "Inbox",
    path: "/inbox",
    seed: (fake, projectId, label) => {
      const task = fake.addTask(projectId, label);
      fake.addSpec(task.id);
      fake.transition(task.id, "refined", null);
      return task.id;
    },
  },
];

function setup(view: View, label: { title: string | null; intent: string }) {
  const fake = new FakeApi();
  const project = fake.addProject({ name: "lunas-queue" });
  const taskId = view.seed(fake, project.id, label);
  renderApp(view.path, fake);
  return { fake, taskId };
}

const taskLink = (taskId: string) =>
  waitFor(() => {
    const link = screen
      .getAllByRole("link")
      .find((l) => (l as HTMLAnchorElement).href.endsWith(`/tasks/${taskId}`));
    if (!link) throw new Error("task link not found");
    return link;
  });

describe.each(views)("$name view caps the task label", (view) => {
  it("shows the first 69 characters and «...» for a title over the cap", async () => {
    const { taskId } = setup(view, { title: LONG, intent: "intención corta" });
    const link = await taskLink(taskId);
    expect(link.textContent).toBe(CAPPED);
    expect(link.textContent).toHaveLength(TASK_TITLE_MAX);
  });

  it("caps the intent when the task has no title yet", async () => {
    const { taskId } = setup(view, { title: null, intent: LONG });
    expect((await taskLink(taskId)).textContent).toBe(CAPPED);
  });

  it("leaves a label of exactly the cap unchanged", async () => {
    const { taskId } = setup(view, { title: EXACT, intent: "x" });
    expect((await taskLink(taskId)).textContent).toBe(EXACT);
  });

  it("leaves a short label unchanged, without an ellipsis", async () => {
    const { taskId } = setup(view, { title: null, intent: "Login con email" });
    expect((await taskLink(taskId)).textContent).toBe("Login con email");
  });
});

describe("task detail keeps the full label", () => {
  it("shows the full stored title", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const task = fake.addTask(project.id, { title: LONG, intent: "corta" });
    renderApp(`/tasks/${task.id}`, fake);
    expect(await screen.findByRole("heading", { name: LONG })).toBeTruthy();
  });

  it("shows the full stored intent while there is no title", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const task = fake.addTask(project.id, { intent: LONG });
    renderApp(`/tasks/${task.id}`, fake);
    expect(await screen.findByRole("heading", { name: LONG })).toBeTruthy();
    expect(within(document.body).queryByText(CAPPED)).toBeNull();
  });
});
