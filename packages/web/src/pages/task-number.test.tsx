import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

function seeded() {
  const fake = new FakeApi();
  const project = fake.addProject({ name: "lunas-queue" });
  // Números lejos del 1 para que no coincidan con posiciones ni prioridades.
  const base = fake.addTask(project.id, { intent: "Esquema base", number: 41 });
  const task = fake.addTask(project.id, { intent: "Login con email", number: 42 });
  fake.edges.push({ taskId: task.id, dependsOnId: base.id });
  return { fake, project, base, task };
}

/** El #N de la tarea va junto a su intent: el elemento que lo contiene también tiene el intent. */
function nextToIntent(scope: ReturnType<typeof within>, number: number, intent: string) {
  const label = scope.getByText(`#${number}`);
  expect(label.parentElement?.textContent).toContain(intent);
}

describe("número de tarea en las vistas", () => {
  it("tablero: cada tarjeta muestra el #N junto al intent", async () => {
    const { fake, project } = seeded();
    renderApp(`/projects/${project.id}`, fake);
    const draft = within(await screen.findByRole("region", { name: "Draft" }));
    await draft.findByRole("link", { name: "Login con email" });
    nextToIntent(draft, 42, "Login con email");
    nextToIntent(draft, 41, "Esquema base");
  });

  it("cola: cada fila muestra el #N junto al intent", async () => {
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

  it("bandeja: cada pendiente muestra el #N de su tarea", async () => {
    const { fake, task } = seeded();
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    renderApp("/inbox", fake);
    const specs = within(await screen.findByRole("region", { name: "Specs por aprobar" }));
    const item = within(await specs.findByRole("article", { name: "Login con email" }));
    nextToIntent(item, 42, "Login con email");
  });

  it("detalle: la cabecera y las dependencias muestran el #N", async () => {
    const { fake, task } = seeded();
    renderApp(`/tasks/${task.id}`, fake);
    await screen.findByRole("heading", { name: "Login con email" });
    expect(screen.getByText("#42")).toBeTruthy();
    const deps = within(await screen.findByRole("region", { name: "Dependencias" }));
    await deps.findByRole("link", { name: "Esquema base" });
    nextToIntent(deps, 41, "Esquema base");
  });

  it("detalle: el selector para agregar dependencia muestra el #N de cada candidata", async () => {
    const { fake, project, task } = seeded();
    fake.addTask(project.id, { intent: "Endpoint de login", number: 43 });
    renderApp(`/tasks/${task.id}`, fake);
    const deps = within(await screen.findByRole("region", { name: "Dependencias" }));
    const select = await deps.findByLabelText("Agregar dependencia");
    const option = within(select).getByRole("option", { name: /Endpoint de login/ });
    expect(option.textContent).toContain("#43");
  });
});
