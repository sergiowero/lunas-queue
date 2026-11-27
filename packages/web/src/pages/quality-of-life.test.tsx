// Small conveniences across pages: tab title, copy buttons, relative times, Ctrl/Cmd+Enter,
// board counts, run durations, Result links, dialogs that keep edits and empty-state next steps.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

describe("tab title", () => {
  it("names the page and the task, and counts what waits in the Inbox", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    const task = fake.addTask(project.id, { goal: "Login con email" });
    renderApp(`/tasks/${task.id}`, fake);
    await waitFor(() => expect(document.title).toBe(`#${task.number} · Login con email — LunasQ`));
  });

  it("prefixes the pending count when something needs the human", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    fake.addTask(project.id, { goal: "Atascada", state: "needs_human", subState: null });
    renderApp("/queue", fake);
    await waitFor(() => expect(document.title).toBe("(1) Cola global — LunasQ"));
  });
});

describe("task detail", () => {
  it("copies the branch, the worktree and the PR URL", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    const task = fake.addTask(project.id, {
      branch: "lunasq/abc",
      worktreePath: "/tmp/wt/abc",
      prUrl: "https://github.com/o/r/pull/3",
      prState: "open",
    });
    // user-event replaces navigator.clipboard with an in-memory one that readText can check.
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const copied = async (name: string) => {
      await user.click(await screen.findByRole("button", { name }));
      return navigator.clipboard.readText();
    };

    expect(await copied("Copiar Branch")).toBe("lunasq/abc");
    expect(await copied("Copiar Worktree")).toBe("/tmp/wt/abc");
    expect(await copied("Copiar PR")).toBe("https://github.com/o/r/pull/3");
    expect(screen.getAllByText("Copiado").length).toBeGreaterThan(0);
  });

  it("shows the creation time relative to now with the exact date on hover", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    const createdAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const task = fake.addTask(project.id, { createdAt });
    renderApp(`/tasks/${task.id}`, fake);
    const time = await screen.findByText("hace 5 min");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("dateTime")).toBe(createdAt);
    expect(time.getAttribute("title")).toBeTruthy();
  });

  it("names the originating task by number and label instead of its id", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    const origin = fake.addTask(project.id, { goal: "Tarea de origen" });
    const task = fake.addTask(project.id, { causedBy: origin.id });
    renderApp(`/tasks/${task.id}`, fake);
    const link = await screen.findByRole("link", { name: `#${origin.number} Tarea de origen` });
    expect(link.getAttribute("href")).toBe(`/tasks/${origin.id}`);
  });

  it("shows how long each Run took", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    const task = fake.addTask(project.id, { state: "in_progress", subState: "running" });
    const run = fake.startRun(task.id, "implement");
    fake.endRun(run.id, {
      endedAt: new Date(Date.parse(run.startedAt) + 3 * 60_000).toISOString(),
    });
    renderApp(`/tasks/${task.id}`, fake);
    const runs = within(await screen.findByRole("region", { name: "Runs" }));
    expect(await runs.findByRole("columnheader", { name: "Duración" })).toBeTruthy();
    expect(runs.getByText("3 min")).toBeTruthy();
  });

  it("opens links in a Result in a new tab", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    const task = fake.addTask(project.id, {
      state: "completed",
      subState: null,
      resultKind: "research",
      result: "Ver [la doc](https://example.com/doc)",
    });
    renderApp(`/tasks/${task.id}`, fake);
    const link = await screen.findByRole("link", { name: "la doc" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });
});

describe("new task", () => {
  it("creates the task with Ctrl+Enter from the goal and focuses it when the project is preset", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "uno" });
    const { user, router } = renderApp(`/tasks/new?projectId=${project.id}`, fake);
    const goal = await screen.findByLabelText("Objetivo");
    expect(document.activeElement).toBe(goal);
    await user.type(goal, "Algo nuevo");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/tasks\/(?!new)/));
    expect(fake.tasks.some((t) => t.goal === "Algo nuevo")).toBe(true);
  });
});

describe("board", () => {
  it("shows how many tasks each column has", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "uno" });
    fake.addTask(project.id, { goal: "A" });
    fake.addTask(project.id, { goal: "B" });
    renderApp(`/projects/${project.id}`, fake);
    const draft = within(await screen.findByRole("region", { name: "Draft" }));
    expect(draft.getByText("2")).toBeTruthy();
  });
});

describe("completed", () => {
  it("lists the most recently completed first with when it was completed", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    const done = { state: "completed", subState: null, prState: "merged" } as const;
    fake.addTask(project.id, { ...done, goal: "Vieja", updatedAt: "2026-01-01T00:00:00Z" });
    fake.addTask(project.id, { ...done, goal: "Reciente", updatedAt: "2026-06-01T00:00:00Z" });
    const { user } = renderApp("/completed", fake);
    const summary = await screen.findByText(/^Resto/);
    await user.click(summary);
    const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
    const body = rows.filter((r) => r.includes("Vieja") || r.includes("Reciente"));
    expect(body[0]).toContain("Reciente");
    expect(screen.getAllByRole("columnheader", { name: "Completada" }).length).toBeGreaterThan(0);
  });
});

describe("empty states", () => {
  it("offers to create a task from an empty queue", async () => {
    renderApp("/queue", new FakeApi());
    await screen.findByText("No hay tareas vivas en la cola.");
    const link = screen.getByRole("link", { name: "Crear una tarea" });
    expect(link.getAttribute("href")).toBe("/tasks/new");
  });
});

describe("project form", () => {
  it("keeps the dialog open on a click outside it, so edits are not lost", async () => {
    const { user } = renderApp("/projects", new FakeApi());
    await user.click(await screen.findByRole("button", { name: "Nuevo proyecto" }));
    const dialog = await screen.findByRole("dialog");
    const backdrop = dialog.previousElementSibling as HTMLElement;
    fireEvent.click(backdrop);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
