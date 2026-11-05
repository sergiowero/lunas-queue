import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../../test/fake-api.ts";
import { EventLogPanel } from "./event-log.tsx";

afterEach(() => vi.unstubAllGlobals());

function setup(extraEvents: string[]) {
  const fake = new FakeApi();
  const task = fake.addTask(fake.addProject().id, { intent: "Migrar" });
  for (const type of extraEvents) fake.event(task.id, type, "agent");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", fake.fetch);
  render(
    <QueryClientProvider client={queryClient}>
      <EventLogPanel taskId={task.id} />
    </QueryClientProvider>,
  );
  return { task, queryClient };
}

const shownTypes = (container: HTMLElement) =>
  [...container.querySelectorAll("li span.font-mono")].map((el) => el.textContent);

describe("EventLogPanel", () => {
  it("lists the most recently written event first and the oldest last", async () => {
    setup(["note.second", "note.third"]);
    await screen.findByText("Mostrar 3 eventos");
    const types = shownTypes(document.body);
    expect(types).toEqual(["note.third", "note.second", "task.created"]);
  });

  it("keeps the total count and shows every event exactly once", async () => {
    setup(["note.second", "note.third"]);
    await screen.findByText("Mostrar 3 eventos");
    const types = shownTypes(document.body);
    expect(types).toHaveLength(3);
    expect(new Set(types).size).toBe(3);
  });

  it("does not mutate the cached events array, which keeps write order", async () => {
    const { task, queryClient } = setup(["note.second", "note.third"]);
    await screen.findByText("Mostrar 3 eventos");
    const cached = queryClient.getQueryData<{ id: number; type: string }[]>([
      "task",
      task.id,
      "events",
    ]);
    expect(cached?.map((e) => e.type)).toEqual(["task.created", "note.second", "note.third"]);
    expect(cached?.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("shows the empty message when the task has no events", async () => {
    const fake = new FakeApi();
    const task = fake.addTask(fake.addProject().id, { intent: "Migrar" });
    fake.events.length = 0;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", fake.fetch);
    render(
      <QueryClientProvider client={queryClient}>
        <EventLogPanel taskId={task.id} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Sin eventos.")).not.toBeNull());
  });
});
