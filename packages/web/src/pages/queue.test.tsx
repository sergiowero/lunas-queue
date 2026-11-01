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
      "Draften cola",
      "5 → 30",
      "42.5",
      "120 · $1.50",
      "",
    ]);
    expect(body[2]?.[5]?.textContent).toBe("—");
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: "Segunda" })).toHaveProperty(
      "href",
      expect.stringContaining(`/tasks/${b.id}`),
    );
  });

  it("la columna Estado muestra una etiqueta por tarea, azul solo para In progress", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    fake.addTask(project.id, { intent: "Borrador" });
    fake.addTask(project.id, { intent: "Verificando", state: "verification", subState: "running" });
    fake.addTask(project.id, { intent: "Bloqueada", state: "needs_human", subState: null });
    fake.addTask(project.id, { intent: "Trabajando", state: "in_progress", subState: "running" });
    fake.queue = fake.tasks.map((task) => ({
      task,
      ready: false,
      score: null,
      effectivePriority: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      },
    }));
    renderApp("/queue", fake);

    const row = async (intent: string) =>
      within((await screen.findByRole("link", { name: intent })).closest("tr") as HTMLElement);
    const variant = async (intent: string, label: string) =>
      (await row(intent)).getByText(label).dataset.variant;
    expect(await variant("Trabajando", "In progress")).toBe("info");
    expect(await variant("Borrador", "Draft")).toBe("secondary");
    expect(await variant("Verificando", "Verification")).toBe("secondary");
    expect(await variant("Bloqueada", "Needs human")).toBe("destructive");
    expect(screen.getAllByText("In progress")).toHaveLength(1);
  });

  describe("columna Acciones", () => {
    const queueOf = (fake: FakeApi) => {
      fake.queue = fake.tasks.map((task) => ({
        task,
        ready: false,
        score: null,
        effectivePriority: null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
        },
      }));
    };
    const rowOf = async (intent: string) =>
      within((await screen.findByRole("link", { name: intent })).closest("tr") as HTMLElement);

    it("la pausable lleva solo el icono de pausa; la pausada y la de needs_human solo el de reanudar", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      fake.addTask(project.id, { intent: "Pausable", state: "in_progress", subState: "running" });
      fake.addTask(project.id, { intent: "Pausada", state: "paused", subState: null });
      fake.addTask(project.id, { intent: "Escalada", state: "needs_human", subState: null });
      queueOf(fake);
      renderApp("/queue", fake);

      expect((await screen.findAllByRole("columnheader")).map((h) => h.textContent).at(-1)).toBe(
        "Acciones",
      );
      const actions = async (intent: string) => {
        const cells = (await rowOf(intent)).getAllByRole("cell");
        return cells[cells.length - 1] as HTMLElement;
      };

      const pausable = within(await actions("Pausable"));
      const pause = pausable.getByRole("button", { name: "Pausar tarea Pausable" });
      expect(pause.textContent).toBe("");
      expect(pause.querySelector('svg[data-icon="pause"]')).not.toBeNull();
      expect(pausable.getAllByRole("button")).toHaveLength(1);

      for (const intent of ["Pausada", "Escalada"]) {
        const cell = within(await actions(intent));
        const resume = cell.getByRole("button", { name: `Reanudar tarea ${intent}` });
        expect(resume.textContent).toBe("");
        expect(resume.querySelector('svg[data-icon="resume"]')).not.toBeNull();
        expect(cell.getAllByRole("button")).toHaveLength(1);
      }
    });

    it("pausar desde la Cola mueve la tarea a Paused y ofrece reanudarla", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const task = fake.addTask(project.id, {
        intent: "Se pausa",
        state: "refined",
        subState: null,
      });
      const { user } = renderApp("/queue", fake);

      await user.click(await screen.findByRole("button", { name: "Pausar tarea Se pausa" }));

      expect(await screen.findByRole("button", { name: "Reanudar tarea Se pausa" })).toBeTruthy();
      expect(fake.task(task.id).state).toBe("paused");
      expect(screen.getByText("Paused")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Reanudar tarea Se pausa" }));

      expect(await screen.findByRole("button", { name: "Pausar tarea Se pausa" })).toBeTruthy();
      expect(fake.task(task.id).state).toBe("refined");
    });

    it("si la API rechaza la acción muestra el error con role alert en esa fila", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const task = fake.addTask(project.id, { intent: "Rechazada", state: "draft" });
      fake.addTask(project.id, { intent: "Intacta", state: "draft" });
      const { user } = renderApp("/queue", fake);
      const button = await screen.findByRole("button", { name: "Pausar tarea Rechazada" });
      fake.task(task.id).state = "completed";

      await user.click(button);

      expect((await (await rowOf("Rechazada")).findByRole("alert")).textContent).toMatch(
        /pause no aplica/,
      );
      expect((await rowOf("Intacta")).queryByRole("alert")).toBeNull();
    });
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
