import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { CHANGE_STREAM_URL } from "./live.ts";

/** Minimal EventSource: the tests fire the messages by hand. */
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

describe("live updates over SSE", () => {
  it("a task change refreshes its detail without waiting for the interval", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    const project = fake.addProject();
    const task = fake.addTask(project.id, { goal: "En vivo" });
    renderApp(`/tasks/${task.id}`, fake);
    expect(await screen.findByText("Draft")).toBeTruthy();

    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe(CHANGE_STREAM_URL);
    fake.transition(task.id, "refined", null);
    source?.emit("change", JSON.stringify({ taskIds: [task.id] }));
    expect(await screen.findByText("Refined")).toBeTruthy();
  });

  it("a change refreshes the hook executions", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    const project = fake.addProject();
    const a = fake.addTask(project.id, { goal: "Primera" });
    fake.hooks.set(project.id, { baseRef: "a".repeat(40), configError: null, points: [] });
    renderApp(`/projects/${project.id}/hooks`, fake);
    await screen.findByRole("heading", { name: /Hooks/ });
    const before = fake.requests.filter((r) => r.path.endsWith("/hooks/executions")).length;
    FakeEventSource.instances[0]?.emit("change", JSON.stringify({ taskIds: [a.id] }));
    await waitFor(() =>
      expect(
        fake.requests.filter((r) => r.path.endsWith("/hooks/executions")).length,
      ).toBeGreaterThan(before),
    );
  });

  it("a configuration change refreshes Settings and the notice even without tasks", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    renderApp("/settings", fake);
    const claude = await screen.findByRole("switch", { name: "Claude" });
    expect(claude.getAttribute("aria-checked")).toBe("true");

    // Another tab turns off all providers: here only the global change arrives.
    fake.providers = { claude: false, copilot: false, codex: false };
    FakeEventSource.instances[0]?.emit("change", JSON.stringify({ taskIds: [], settings: true }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Claude" }).getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("ignores unreadable messages and closes the connection on unmount", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const { unmount } = renderApp("/queue");
    await screen.findByText("No hay tareas vivas en la cola.");
    const source = FakeEventSource.instances[0];
    source?.emit("change", "{roto");
    unmount();
    expect(source?.closed).toBe(true);
  });

  it("a task that leaves In progress disappears from the In progress tab", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    const project = fake.addProject();
    const task = fake.addTask(project.id, { goal: "Saldrá de curso" });
    fake.transition(task.id, "in_progress", "running");
    fake.addTask(project.id, {
      goal: "Sigue en curso",
      state: "in_progress",
      subState: "queued",
    });
    renderApp("/in-progress", fake);
    await screen.findByText("Saldrá de curso");

    fake.transition(task.id, "verification", "queued");
    const source = FakeEventSource.instances.find((s) => s.url === CHANGE_STREAM_URL);
    source?.emit("change", JSON.stringify({ taskIds: [task.id] }));
    await waitFor(() => expect(screen.queryByText("Saldrá de curso")).toBeNull());
    expect(screen.getByText("Sigue en curso")).toBeTruthy();
  });

  it("a change brings the new question to the inbox", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fake = new FakeApi();
    const task = fake.addTask(fake.addProject().id, { goal: "Pregunta en vivo" });
    fake.transition(task.id, "in_progress", "running");
    renderApp("/inbox", fake);
    await screen.findByText("Ningún agente espera una respuesta.");

    fake.ask(task.id, "¿Uso UUID v7?");
    const source = FakeEventSource.instances.find((s) => s.url === CHANGE_STREAM_URL);
    source?.emit("change", JSON.stringify({ taskIds: [task.id] }));
    expect(await screen.findByText("¿Uso UUID v7?")).toBeTruthy();
  });
});
