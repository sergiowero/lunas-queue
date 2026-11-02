import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { CHANGE_STREAM_URL } from "../lib/live.ts";

/** EventSource mínimo: los tests disparan los mensajes a mano. */
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

describe("contador del enlace En curso", () => {
  it("muestra las tareas en curso de todos los proyectos y las anuncia en el nombre accesible", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "A", state: "in_progress", subState: "queued" });
    fake.addTask(two.id, { intent: "B", state: "in_progress", subState: "waiting_human" });
    fake.addTask(two.id, { intent: "C", state: "verification", subState: "running" });
    fake.addTask(one.id, { intent: "Borrador" });
    fake.addTask(one.id, { intent: "Esperando", state: "verification", subState: "waiting_human" });
    fake.addTask(two.id, { intent: "Terminada", state: "completed", subState: null });
    renderApp("/queue", fake);

    const link = await screen.findByRole("link", { name: "En curso, 3 tareas" });
    expect(link.getAttribute("href")).toBe("/in-progress");
    expect(within(link).getByText("3")).toBeTruthy();
  });

  it("con una sola tarea en curso el nombre accesible va en singular", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, { state: "in_progress", subState: "running" });
    renderApp("/queue", fake);

    expect(await screen.findByRole("link", { name: "En curso, 1 tarea" })).toBeTruthy();
  });

  it("sin tareas en curso el enlace se ve solo con su texto", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, { intent: "Borrador" });
    renderApp("/queue", fake);

    await screen.findByText("Borrador");
    const link = await screen.findByRole("link", { name: "En curso" });
    expect(link.textContent).toBe("En curso");
    expect(link.getAttribute("aria-label")).toBeNull();
  });

  it("se actualiza en vivo cuando una tarea sale o entra de En curso", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    const project = fake.addProject();
    const task = fake.addTask(project.id, {
      intent: "Sale",
      state: "in_progress",
      subState: "running",
    });
    const other = fake.addTask(project.id, { intent: "Entra" });
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

  it("no depende del proyecto elegido en la página En curso", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "U1", state: "in_progress", subState: "running" });
    fake.addTask(one.id, { intent: "U2", state: "in_progress", subState: "queued" });
    fake.addTask(two.id, { intent: "D1", state: "in_progress", subState: "running" });
    const { user } = renderApp("/in-progress", fake);

    await screen.findByText("D1");
    await user.selectOptions(screen.getByLabelText("Proyecto"), one.id);
    await waitFor(() => expect(screen.queryByText("D1")).toBeNull());
    expect(screen.getByText("U1")).toBeTruthy();
    expect(screen.getByRole("link", { name: "En curso, 3 tareas" })).toBeTruthy();
  });
});
