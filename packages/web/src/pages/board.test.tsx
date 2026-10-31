import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

describe("tablero por proyecto", () => {
  it("agrupa las tareas del proyecto en columnas por estado", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const other = fake.addProject();
    fake.addTask(project.id, { intent: "Por refinar" });
    fake.addTask(project.id, {
      intent: "Implementando",
      state: "in_progress",
      subState: "running",
    });
    fake.addTask(project.id, {
      intent: "Entregada",
      state: "completed",
      subState: null,
      prUrl: "https://github.com/o/r/pull/7",
      prState: "merged",
    });
    fake.addTask(other.id, { intent: "Ajena" });
    renderApp(`/projects/${project.id}`, fake);

    expect(await screen.findByRole("heading", { name: "lunas-queue" })).toBeTruthy();
    const column = (name: string) => within(screen.getByRole("region", { name }));
    expect(column("Draft").getByRole("link", { name: "Por refinar" })).toBeTruthy();
    expect(column("In progress").getByText("corriendo")).toBeTruthy();
    expect(column("Completed").getByRole("link", { name: "PR merged" })).toHaveProperty(
      "href",
      "https://github.com/o/r/pull/7",
    );
    expect(column("Refined").getByText("Sin tareas")).toBeTruthy();
    expect(screen.queryByText("Ajena")).toBeNull();
  });

  it("muestra el título de la tarea y, mientras no hay, su intent", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    fake.addTask(project.id, { intent: "Intent largo de la primera", title: "Título corto" });
    fake.addTask(project.id, { intent: "Sin refinar todavía" });
    renderApp(`/projects/${project.id}`, fake);

    expect(await screen.findByRole("link", { name: "Título corto" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sin refinar todavía" })).toBeTruthy();
    expect(screen.queryByText("Intent largo de la primera")).toBeNull();
  });

  it("enlaza al alta de tareas con el proyecto elegido", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const { user, router } = renderApp(`/projects/${project.id}`, fake);
    await user.click(await screen.findByRole("link", { name: "Nueva tarea en este proyecto" }));
    expect(router.state.location.pathname).toBe("/tasks/new");
    expect(router.state.location.search).toEqual({ projectId: project.id });
  });

  it("lista los proyectos en /projects", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue", repo: "sergiowero/lunas-queue" });
    renderApp("/projects", fake);
    expect(await screen.findByRole("link", { name: "lunas-queue" })).toHaveProperty(
      "href",
      expect.stringContaining(`/projects/${project.id}`),
    );
    expect(screen.getByText("sergiowero/lunas-queue")).toBeTruthy();
  });
});
