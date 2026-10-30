import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

describe("cola global", () => {
  it("muestra las tareas en el orden del servidor, con score, estado, proyecto y usage", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const a = fake.addTask(project.id, { intent: "Primera", priority: 10 });
    const b = fake.addTask(project.id, { intent: "Segunda", priority: 5 });
    const running = fake.addTask(project.id, { intent: "Corriendo", subState: "running" });
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
    fake.queue = [
      {
        task: b,
        ready: true,
        score: 42.5,
        effectivePriority: 30,
        usage: { ...usage, costUsd: 1.5 },
      },
      {
        task: a,
        ready: true,
        score: 10,
        effectivePriority: 10,
        usage: { ...usage, costUsd: null },
      },
      {
        task: running,
        ready: false,
        score: null,
        effectivePriority: null,
        usage: { ...usage, costUsd: null },
      },
    ];
    renderApp("/queue", fake);

    const rows = await screen.findAllByRole("row");
    const body = rows.slice(1).map((row) => within(row).getAllByRole("cell"));
    // La celda de la tarea lleva su #N antes del intent.
    expect(body.map((cells) => cells[1]?.textContent)).toEqual([
      `#${b.number}Segunda`,
      `#${a.number}Primera`,
      `#${running.number}Corriendo`,
    ]);
    expect(body[0]?.map((c) => c.textContent)).toEqual([
      "1",
      `#${b.number}Segunda`,
      "lunas-queue",
      "Draft · en cola",
      "5 → 30",
      "42.5",
      "120 · $1.50",
    ]);
    expect(body[2]?.[5]?.textContent).toBe("—");
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: "Segunda" })).toHaveProperty(
      "href",
      expect.stringContaining(`/tasks/${b.id}`),
    );
  });

  it("filtra por proyecto", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "De uno" });
    fake.addTask(two.id, { intent: "De dos" });
    const { user } = renderApp("/queue", fake);

    await screen.findByText("De dos");
    await user.selectOptions(screen.getByLabelText("Proyecto"), "uno");
    await waitFor(() => expect(screen.queryByText("De dos")).toBeNull());
    expect(screen.getByText("De uno")).toBeTruthy();
    expect(fake.requests.at(-1)?.path).toBe(`/api/queue?projectId=${one.id}`);
  });

  it("explica cuando la cola está vacía", async () => {
    renderApp("/queue");
    expect(await screen.findByText("No hay tareas vivas en la cola.")).toBeTruthy();
  });
});
