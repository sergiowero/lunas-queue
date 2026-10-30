import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { CHANGE_STREAM_URL, NOTIFICATION_STREAM_URL } from "./live.ts";

/** EventSource mínimo: los tests disparan los mensajes a mano. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
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

  close() {
    this.closed = true;
  }

  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data }));
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
});

describe("actualización en vivo por SSE", () => {
  it("un change de la tarea refresca su detalle sin esperar el intervalo", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    const project = fake.addProject();
    const task = fake.addTask(project.id, { intent: "En vivo" });
    renderApp(`/tasks/${task.id}`, fake);
    expect(await screen.findByText("Draft")).toBeTruthy();

    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe(CHANGE_STREAM_URL);
    fake.transition(task.id, "refined", null);
    source?.emit("change", JSON.stringify({ taskIds: [task.id] }));
    expect(await screen.findByText("Refined")).toBeTruthy();
  });

  it("ignora mensajes ilegibles y cierra la conexión al desmontar", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { unmount } = renderApp("/queue");
    await screen.findByText("No hay tareas vivas en la cola.");
    const source = FakeEventSource.instances[0];
    source?.emit("change", "{roto");
    unmount();
    expect(FakeEventSource.instances.map((s) => s.closed)).toEqual([true, true]);
  });

  it("un change trae a la bandeja la pregunta nueva", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    const task = fake.addTask(fake.addProject().id, { intent: "Pregunta en vivo" });
    fake.transition(task.id, "in_progress", "running");
    renderApp("/inbox", fake);
    await screen.findByText("Ningún agente espera una respuesta.");

    fake.ask(task.id, "¿Uso UUID v7?");
    const source = FakeEventSource.instances.find((s) => s.url === CHANGE_STREAM_URL);
    source?.emit("change", JSON.stringify({ taskIds: [task.id] }));
    expect(await screen.findByText("¿Uso UUID v7?")).toBeTruthy();
  });

  it("una notificación trae a la bandeja el agente bloqueado", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    const task = fake.addTask(fake.addProject().id, { intent: "Bloqueo en vivo" });
    const run = fake.startRun(task.id, "implement");
    renderApp("/inbox", fake);
    await screen.findByText("Ningún agente espera un permiso.");

    fake.block(run);
    const source = FakeEventSource.instances.find((s) => s.url === NOTIFICATION_STREAM_URL);
    source?.emit("notification", JSON.stringify({ kind: "agent_blocked", taskId: task.id }));
    expect(await screen.findByText(run.herdrName as string)).toBeTruthy();
  });
});
