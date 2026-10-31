import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { THEME_KEY } from "../lib/theme.ts";

function setup() {
  const fake = new FakeApi();
  const project = fake.addProject({ name: "lunas-queue" });
  const base = fake.addTask(project.id, {
    intent: "Esquema base",
    state: "completed",
    subState: null,
  });
  const api = fake.addTask(project.id, {
    intent: "API de tareas",
    state: "in_progress",
    subState: "running",
  });
  const ui = fake.addTask(project.id, { intent: "Pantalla de tareas" });
  fake.addTask(project.id, { intent: "Suelta" });
  fake.edges.push({ taskId: api.id, dependsOnId: base.id }, { taskId: ui.id, dependsOnId: api.id });
  return { fake, project, base, api, ui };
}

describe("vista de DAG", () => {
  it("dibuja las tareas con su estado y enlace al detalle", async () => {
    const { fake, api } = setup();
    renderApp("/dag", fake);

    const graph = await screen.findByRole("region", { name: "Grafo de dependencias" });
    const link = await within(graph).findByRole("link", { name: /API de tareas/ });
    expect(link).toHaveProperty("href", expect.stringContaining(`/tasks/${api.id}`));
    expect(within(graph).getByRole("link", { name: /Suelta/ })).toBeTruthy();
    expect(within(graph).getByText("corriendo")).toBeTruthy();
    expect(within(graph).getByText("Completed")).toBeTruthy();
  });

  it("lista las dependencias reales, una por arista", async () => {
    const { fake } = setup();
    renderApp("/dag", fake);

    const list = await screen.findByRole("list", { name: "Dependencias" });
    const pairs = within(list)
      .getAllByRole("listitem")
      .map((li) =>
        within(li)
          .getAllByRole("link")
          .map((l) => l.textContent),
      );
    expect(pairs).toEqual([
      ["API de tareas", "Esquema base"],
      ["Pantalla de tareas", "API de tareas"],
    ]);
  });

  it("filtra por proyecto y marca las dependencias entre proyectos", async () => {
    const { fake, project, api } = setup();
    const other = fake.addProject({ name: "ajeno" });
    const upstream = fake.addTask(other.id, { intent: "Contrato externo" });
    fake.addTask(other.id, { intent: "Sin relación" });
    fake.edges.push({ taskId: api.id, dependsOnId: upstream.id });
    const { user } = renderApp("/dag", fake);

    const region = () => screen.findByRole("region", { name: "Grafo de dependencias" });
    await within(await region()).findByRole("link", { name: /Sin relación/ });
    await user.selectOptions(screen.getByLabelText("Proyecto"), project.id);

    // El grafo se vuelve a pedir y a dibujar: no se reutiliza el elemento anterior.
    const filtered = within(await region());
    await filtered.findByRole("link", { name: /Contrato externo/ });
    expect(filtered.queryByRole("link", { name: /Sin relación/ })).toBeNull();
    expect(fake.requests.map((r) => r.path)).toContain(`/api/graph?projectId=${project.id}`);
    const item = screen
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("Contrato externo"));
    expect(item?.textContent).toContain("otro proyecto");
  });

  it("muestra un aviso si no hay tareas", async () => {
    renderApp("/dag", new FakeApi());
    expect(await screen.findByText("Sin tareas que mostrar.")).toBeTruthy();
  });

  it("se refresca cuando cambian las dependencias", async () => {
    const { fake, base, ui } = setup();
    const { refresh } = renderApp("/dag", fake);
    await screen.findByRole("list", { name: "Dependencias" });

    fake.edges.push({ taskId: ui.id, dependsOnId: base.id });
    await refresh();
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
  });
});

describe("vista de DAG con tema", () => {
  it("en tema oscuro, React Flow usa su colorMode oscuro y cambia al alternar el tema", async () => {
    localStorage.setItem(THEME_KEY, "dark");
    const { fake } = setup();
    const { user } = renderApp("/dag", fake);

    const graph = await screen.findByRole("region", { name: "Grafo de dependencias" });
    const flow = graph.querySelector(".react-flow");
    expect(flow?.classList.contains("dark")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Cambiar a tema claro" }));
    expect(flow?.classList.contains("dark")).toBe(false);
    expect(flow?.classList.contains("light")).toBe(true);
  });
});
