import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

describe("alta de tareas", () => {
  it("crea la tarea con tags, prioridad y dependencias y abre su detalle", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const dep = fake.addTask(project.id, { intent: "Base de datos" });
    fake.addTask(project.id, { intent: "Ya cancelada", state: "cancelled", subState: null });
    const { user, router } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.type(screen.getByLabelText("Intent"), "Login con email");
    await user.type(screen.getByLabelText("Tags"), "auth, ui ,");
    await user.clear(screen.getByLabelText("Prioridad"));
    await user.type(screen.getByLabelText("Prioridad"), "250");
    expect(screen.queryByLabelText("Ya cancelada")).toBeNull();
    await user.click(await screen.findByLabelText("Base de datos"));
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/tasks\/[0-9a-f-]+$/));
    expect(fake.requests.find((r) => r.method === "POST")?.body).toEqual({
      projectId: project.id,
      intent: "Login con email",
      tags: ["auth", "ui"],
      priority: 250,
      dependsOn: [dep.id],
    });
    expect(await screen.findByRole("heading", { name: "Login con email" })).toBeTruthy();
  });

  it("permite depender de tareas de otro proyecto y las marca", async () => {
    const fake = new FakeApi();
    const mine = fake.addProject({ name: "web" });
    const other = fake.addProject({ name: "api" });
    const remote = fake.addTask(other.id, { intent: "Endpoint de login" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "web");
    expect(await screen.findByText("api · otro proyecto")).toBeTruthy();
    await user.type(screen.getByLabelText("Intent"), "Pantalla de login");
    await user.click(screen.getByLabelText("Endpoint de login"));
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));
    await screen.findByRole("heading", { name: "Pantalla de login" });
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      projectId: mine.id,
      dependsOn: [remote.id],
    });
  });

  it("preselecciona el proyecto de la URL", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    renderApp(`/tasks/new?projectId=${two.id}`, fake);
    await waitFor(() =>
      expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe(two.id),
    );
  });

  it("muestra los errores de validación del servidor", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "uno" });
    const { user, router } = renderApp("/tasks/new", fake);
    await user.selectOptions(await screen.findByLabelText("Proyecto"), "uno");
    await user.type(screen.getByLabelText("Intent"), "   ");
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("intent: Too small"),
    );
    expect(router.state.location.pathname).toBe("/tasks/new");
  });
});
