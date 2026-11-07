import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { CHANGE_STREAM_URL } from "../lib/live.ts";

/** Minimal EventSource: the tests fire the messages by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  private readonly listeners = new Map<string, Set<(e: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  removeEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  close() {}

  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data }));
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
});

function emitChange(taskId: string) {
  FakeEventSource.instances
    .find((s) => s.url === CHANGE_STREAM_URL)
    ?.emit("change", JSON.stringify({ taskIds: [taskId] }));
}

describe("In progress link counter", () => {
  it("shows the in-progress tasks of all projects and announces them in the accessible name", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { goal: "A", state: "in_progress", subState: "queued" });
    fake.addTask(two.id, { goal: "B", state: "in_progress", subState: "waiting_human" });
    fake.addTask(two.id, { goal: "C", state: "verification", subState: "running" });
    fake.addTask(one.id, { goal: "Borrador" });
    fake.addTask(one.id, { goal: "Esperando", state: "verification", subState: "waiting_human" });
    fake.addTask(two.id, { goal: "Terminada", state: "completed", subState: null });
    renderApp("/queue", fake);

    const link = await screen.findByRole("link", { name: "En curso, 3 tareas" });
    expect(link.getAttribute("href")).toBe("/in-progress");
    expect(within(link).getByText("3")).toBeTruthy();
  });

  it("with a single task in progress the accessible name is singular", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, { state: "in_progress", subState: "running" });
    renderApp("/queue", fake);

    expect(await screen.findByRole("link", { name: "En curso, 1 tarea" })).toBeTruthy();
  });

  it("without tasks in progress the link shows only its text", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, { goal: "Borrador" });
    renderApp("/queue", fake);

    await screen.findByText("Borrador");
    const link = await screen.findByRole("link", { name: "En curso" });
    expect(link.textContent).toBe("En curso");
    expect(link.getAttribute("aria-label")).toBeNull();
  });

  it("updates live when a task leaves or enters In progress", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    const project = fake.addProject();
    const task = fake.addTask(project.id, {
      goal: "Sale",
      state: "in_progress",
      subState: "running",
    });
    const other = fake.addTask(project.id, { goal: "Entra" });
    renderApp("/queue", fake);
    await screen.findByRole("link", { name: "En curso, 1 tarea" });

    fake.transition(task.id, "verification", "waiting_human");
    emitChange(task.id);
    await waitFor(() => expect(screen.getByRole("link", { name: "En curso" })).toBeTruthy());

    fake.transition(other.id, "in_progress", "queued");
    emitChange(other.id);
    expect(await screen.findByRole("link", { name: "En curso, 1 tarea" })).toBeTruthy();

    fake.transition(task.id, "in_progress", "running");
    emitChange(task.id);
    expect(await screen.findByRole("link", { name: "En curso, 2 tareas" })).toBeTruthy();
  });

  it("does not depend on the project chosen on the In progress page", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { goal: "U1", state: "in_progress", subState: "running" });
    fake.addTask(one.id, { goal: "U2", state: "in_progress", subState: "queued" });
    fake.addTask(two.id, { goal: "D1", state: "in_progress", subState: "running" });
    const { user } = renderApp("/in-progress", fake);

    await screen.findByText("D1");
    await user.selectOptions(screen.getByLabelText("Proyecto"), one.id);
    await waitFor(() => expect(screen.queryByText("D1")).toBeNull());
    expect(screen.getByText("U1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "En curso, 3 tareas" })).toBeTruthy();
  });
});

type Pr = "open" | "merged" | "closed" | null;

function completed(fake: FakeApi, projectId: string, prState: Pr) {
  return fake.addTask(projectId, {
    state: "completed",
    subState: null,
    prState,
    prUrl: prState ? "https://github.com/o/r/pull/1" : null,
  });
}

const menu = async () => within(await screen.findByRole("navigation"));

describe("open PR counter on the Completed tab", () => {
  it("counts only completed tasks with an open PR", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "uno" });
    for (const pr of ["open", "open", "open", "merged", "closed", null] as Pr[]) {
      completed(fake, project.id, pr);
    }
    fake.addTask(project.id, { state: "in_progress", subState: "running", prState: "open" });
    renderApp("/queue", fake);

    const nav = await menu();
    const link = await nav.findByRole("link", { name: "Completed, 3 PR abiertos" });
    expect(within(link).getByText("3")).toBeTruthy();
  });

  it("without open PRs it shows no number and the accessible name is just Completed", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "uno" });
    completed(fake, project.id, "merged");
    completed(fake, project.id, null);
    renderApp("/queue", fake);

    const nav = await menu();
    const link = await nav.findByRole("link", { name: "Completed" });
    expect(link.querySelector("[data-variant]")).toBeNull();
    expect(link.textContent).toBe("Completed");
  });

  it("adds up the open PRs of all projects", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    completed(fake, one.id, "open");
    completed(fake, two.id, "open");
    completed(fake, two.id, "open");
    renderApp("/queue", fake);

    expect(
      await (await menu()).findByRole("link", { name: "Completed, 3 PR abiertos" }),
    ).toBeTruthy();
  });

  it("the badge is green (success) and the Inbox's stays destructive", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "uno" });
    completed(fake, project.id, "open");
    const refined = fake.addTask(project.id, { goal: "Spec" });
    fake.addSpec(refined.id);
    fake.transition(refined.id, "refined", null);
    renderApp("/queue", fake);

    const nav = await menu();
    const prs = await nav.findByRole("link", { name: "Completed, 1 PR abiertos" });
    expect(prs.querySelector("[data-variant]")?.getAttribute("data-variant")).toBe("success");
    const inbox = await nav.findByRole("link", { name: "Bandeja, 1 pendientes" });
    expect(inbox.querySelector("[data-variant]")?.getAttribute("data-variant")).toBe("destructive");
  });

  it("drops from 2 to 1 when a PR becomes merged and the update arrives", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "uno" });
    const first = completed(fake, project.id, "open");
    completed(fake, project.id, "open");
    const { refresh } = renderApp("/queue", fake);
    const nav = await menu();
    expect(await nav.findByRole("link", { name: "Completed, 2 PR abiertos" })).toBeTruthy();

    first.prState = "merged";
    await refresh();

    await waitFor(() =>
      expect(nav.getByRole("link", { name: "Completed, 1 PR abiertos" })).toBeTruthy(),
    );
  });
});
